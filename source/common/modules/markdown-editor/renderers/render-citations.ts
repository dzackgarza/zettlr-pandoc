/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        CitationRenderer
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This renderer can display and pre-render citations.
 *
 * END HEADER
 */

import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, StateEffect, StateField } from "@codemirror/state";
import { type EditorView, WidgetType } from "@codemirror/view";
import { reportError } from "@common/util/error-reporting";
import { isSupportedPandocCrossref } from "@common/util/pandoc-quick-reference";
import type { CitationDatabase } from "@dts/common/citeproc";
import { CITEPROC_MAIN_DB } from "@dts/common/citeproc";
import { referenceFamilyOf } from "@dts/common/references";
import { type SyntaxNodeRef } from "@lezer/common";
import { citationMenu } from "../context-menu/citation-menu";
import { NODES, nodeToCiteItem } from "../parser/citation-parser";
import {
  type CitationReading,
  referencePresentationField,
} from "../plugins/workspace-references-field";
import { configField } from "../util/configuration";
import { renderBlockWidgets } from "./base-renderer";
import clickAndSelect from "./click-and-select";

const CITATION_RENDER_CACHE_LIMIT = 256;
const citationRenderCache = new Map<string, Promise<string | undefined>>();
let stopCitationCacheListener: (() => void) | undefined;
// Counts the changes of the citation database. A citation that an editor drew
// at an earlier count shows data that the database no longer has.
let citationDataRevision = 0;

/** The cite items and the form of one citation, as the citation provider reads them. */
export interface CitationRequest {
  items: CiteItem[];
  composite: boolean;
}

function citationCacheKey(library: CitationDatabase, citation: CitationRequest): string {
  return JSON.stringify([library, citation.composite, citation.items]);
}

function ensureCitationCacheInvalidation(): void {
  if (stopCitationCacheListener !== undefined || window.ipc === undefined) {
    return;
  }
  stopCitationCacheListener = window.ipc.on("citeproc-database-updated", () => {
    citationDatabaseChanged();
  });
}

/** The citation database has other data: no earlier answer of the provider stands. */
export function citationDatabaseChanged(): void {
  citationRenderCache.clear();
  citationDataRevision++;
}

const citationDataRevisionEffect = StateEffect.define<number>();

/** The count of citation database changes at which the editor drew its citations. */
const citationDataRevisionField = StateField.define<number>({
  create: () => citationDataRevision,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(citationDataRevisionEffect)) {
        return effect.value;
      }
    }
    return value;
  },
});

/**
 * Draws the citations of an editor again when the citation database changed
 * after the editor drew them.
 */
export function syncCitationData(view: EditorView): void {
  const shown = view.state.field(citationDataRevisionField, false);
  if (shown !== undefined && shown !== citationDataRevision) {
    view.dispatch({ effects: citationDataRevisionEffect.of(citationDataRevision) });
  }
}

/**
 * Asks the citation provider for the rendered form of a citation. Equal
 * requests share one answer until the citation database changes.
 */
export function requestRenderedCitation(
  library: CitationDatabase,
  citation: CitationRequest,
): Promise<string | undefined> {
  ensureCitationCacheInvalidation();
  const key = citationCacheKey(library, citation);
  const cached = citationRenderCache.get(key);
  if (cached !== undefined) {
    citationRenderCache.delete(key);
    citationRenderCache.set(key, cached);
    return cached;
  }

  const pending = window.ipc.invoke("citeproc-provider", {
    command: "get-citation",
    payload: {
      database: library,
      citations: citation.items,
      composite: citation.composite,
    },
  });
  citationRenderCache.set(key, pending);
  if (citationRenderCache.size > CITATION_RENDER_CACHE_LIMIT) {
    const oldest = citationRenderCache.keys().next().value;
    if (oldest !== undefined) {
      citationRenderCache.delete(oldest);
    }
  }
  void pending.catch(() => {
    if (citationRenderCache.get(key) === pending) {
      citationRenderCache.delete(key);
    }
  });
  return pending;
}

export function __resetCitationRenderMemoForTests(): void {
  citationRenderCache.clear();
  stopCitationCacheListener?.();
  stopCitationCacheListener = undefined;
}

function applyRenderedCitation(
  elem: HTMLElement,
  rawCitation: string,
  renderedCitation: string | undefined,
): void {
  elem.classList.remove("citeproc-pending");
  if (renderedCitation !== undefined) {
    elem.classList.remove("error");
    elem.innerHTML = renderedCitation;
  } else {
    elem.textContent = rawCitation;
    elem.classList.add("error");
  }
}

function sameLibrary(a: CitationDatabase, b: CitationDatabase): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

class CitationWidget extends WidgetType {
  /** `library` is the document's bibliography setting; '' names the main database. */
  constructor(
    readonly citation: CitationReading,
    readonly rawCitation: string,
    readonly library: CitationDatabase,
    readonly dataRevision: number,
    readonly error?: string,
  ) {
    super();
  }

  eq(other: CitationWidget): boolean {
    return (
      sameLibrary(other.library, this.library) &&
      other.dataRevision === this.dataRevision &&
      other.rawCitation === this.rawCitation &&
      other.error === this.error &&
      other.citation.composite === this.citation.composite &&
      JSON.stringify(other.citation.items) === JSON.stringify(this.citation.items)
    );
  }

  toDOM(view: EditorView): HTMLElement {
    if (this.error !== undefined) {
      const elem = document.createElement("span");
      elem.classList.add("citeproc-citation", "error");
      elem.textContent = this.rawCitation;
      elem.title = this.error;
      elem.addEventListener("click", clickAndSelect(view));
      return elem;
    }
    const { items } = this.citation;
    // PREDICATE SPLIT (review B5, deliberate): createWidget's takeover gate
    // uses referenceFamilyOf — a key counts as a workspace reference only
    // with a supported family AND a non-empty slug, because those are the
    // keys the chips renderer can resolve. THIS branch uses the looser
    // prefix predicate isSupportedPandocCrossref (empty slugs included) so
    // that every all-prefix-shaped cluster renders as crossref TEXT instead
    // of being sent to citeproc as a fake bibliography lookup. The branch is
    // production-reachable: a bracketed empty-slug cluster such as
    // `[-@fig:]` parses to the item id 'fig:', which referenceFamilyOf
    // rejects (no slug) but isSupportedPandocCrossref accepts — with the
    // workspaceReferencesField present, such clusters land exactly here.
    // Field-less harness states additionally exercise it for full keys.
    const hasCrossref = items.every((i) => isSupportedPandocCrossref(i.id));

    if (hasCrossref) {
      // We're not dealing with a citation, but rather with a crossref-style
      // cross-reference. So we can render it directly. NOTE: We're only
      // supporting all-crossref citations here, not mixed.
      const elem = document.createElement("span");
      elem.classList.add("citeproc-citation");
      const citationTexts = [];
      for (const item of items) {
        const separatorMatch = /^([a-zA-Z0-9]+)([:-])(.*)$/.exec(item.id);
        const type = separatorMatch !== null ? separatorMatch[1] : item.id;
        const label = separatorMatch !== null ? separatorMatch[3] : item.id;
        if (item.prefix !== undefined) {
          citationTexts.push(`${item.prefix.trimEnd()} #${label}`);
        } else if (item["suppress-author"] === true) {
          citationTexts.push(`#${label}`);
        } else {
          citationTexts.push(`${type}. ${label}`);
        }
      }

      elem.textContent = citationTexts.join("; ");
      elem.addEventListener("click", clickAndSelect(view));

      return elem;
    }

    const library = this.library === "" ? CITEPROC_MAIN_DB : this.library;

    const elem = document.createElement("span");
    elem.classList.add("citeproc-citation");
    elem.textContent = this.rawCitation;

    // Production renderers always carry the async preload IPC bridge. A few
    // isolated headless renderer tests intentionally provide only the legacy
    // synchronous citation seam; keep that test-only boundary deterministic.
    if (window.ipc === undefined) {
      applyRenderedCitation(
        elem,
        this.rawCitation,
        window.getCitationCallback(library)(this.citation.items, this.citation.composite),
      );
    } else {
      elem.classList.add("citeproc-pending");
      void requestRenderedCitation(library, this.citation).then(
        (rendered) => {
          applyRenderedCitation(elem, this.rawCitation, rendered);
        },
        (err: unknown) => {
          reportError("Citation preview IPC failed", err);
          applyRenderedCitation(elem, this.rawCitation, undefined);
          elem.title = err instanceof Error ? err.message : String(err);
        },
      );
    }
    elem.addEventListener("click", clickAndSelect(view));

    elem.addEventListener("contextmenu", (event) => {
      const coords = { x: event.clientX, y: event.clientY };
      let node = syntaxTree(view.state).resolveInner(view.posAtDOM(elem), 1);
      while (node.type.name !== NODES.CITATION && node.parent !== null) node = node.parent;
      if (node.type.name === NODES.CITATION) citationMenu(view, coords, node);
    });

    return elem;
  }

  ignoreEvent(event: Event): boolean {
    return event instanceof MouseEvent;
  }
}

function shouldHandleNode(node: SyntaxNodeRef): boolean {
  return node.type.name === NODES.CITATION;
}

function createWidget(state: EditorState, node: SyntaxNodeRef): CitationWidget | undefined {
  const rawCitation = state.sliceDoc(node.from, node.to);
  const library = state.field(configField).metadata.library;
  const dataRevision = state.field(citationDataRevisionField);
  const authored = nodeToCiteItem(node.node, rawCitation, node.from);
  // A state without the workspace reference fields has no Pandoc reading; the
  // editor's own reading of the node stands in.
  const presentation = state.field(referencePresentationField, false);
  if (presentation === undefined) {
    return new CitationWidget(authored, rawCitation, library, dataRevision);
  }

  // Workspace references belong to reference chips; mixed clusters remain authored text.
  if (authored.items.some((item) => referenceFamilyOf(item.id) !== undefined)) return undefined;
  if (presentation.citationError !== undefined) {
    return new CitationWidget(
      authored,
      rawCitation,
      library,
      dataRevision,
      presentation.citationError,
    );
  }
  const reading = presentation.citations?.get(rawCitation);
  return reading === undefined
    ? undefined
    : new CitationWidget(reading, rawCitation, library, dataRevision);
}

function inputsChanged(before: EditorState, after: EditorState): boolean {
  const presentation = after.field(referencePresentationField, false);
  const previous = before.field(referencePresentationField, false);
  return (
    !sameLibrary(
      before.field(configField).metadata.library,
      after.field(configField).metadata.library,
    ) ||
    before.field(citationDataRevisionField) !== after.field(citationDataRevisionField) ||
    previous?.citations !== presentation?.citations ||
    previous?.citationError !== presentation?.citationError
  );
}

export const renderCitations: Extension = [
  citationDataRevisionField,
  renderBlockWidgets([NODES.CITATION], shouldHandleNode, createWidget, inputsChanged),
];
