/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Reference navigation utilities (issue #1 Phase 5)
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The renderer-side reference navigation surface locked by
 *                  test/reference-navigation.spec.ts and wired into the
 *                  Mod-click mousedown path of plugins/click-listeners.ts
 *                  (Citation nodes with supported-family keys, plus Footnote
 *                  nodes) and the reference-chip widget click listener.
 *
 *                  Boundary split (stated once here, asserted in the specs):
 *                  this module owns the RENDERER half of navigation — intent
 *                  resolution at a click position, DocumentLocation capture
 *                  at jump time, same-file follow dispatch, and the outgoing
 *                  documents-provider 'open-file' request for cross-file
 *                  jumps. The MAIN-PROCESS half — per-pane history entries,
 *                  tab reuse/opening, and Back/Forward restoration — is owned
 *                  by the documents provider's TabManager and locked by
 *                  test/tab-manager-history.spec.ts.
 *
 * END HEADER
 */

import { getSyncedVersion } from "@codemirror/collab";
import { foldedRanges, syntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { trans } from "@common/i18n-renderer";
import { runRecoverably } from "@common/util/run-recoverably";
import {
  type DocumentLocation,
  type ReferenceFamily,
  referenceFamilyOf,
  type SourceRange,
} from "@dts/common/references";
import type { SyntaxNode } from "@lezer/common";
import type { DocumentManagerIPCAPI } from "source/app/service-providers/documents";
import { NODES } from "../parser/citation-parser";
import { editorMetadataFacet } from "../plugins/editor-metadata";
import { workspaceReferencesField } from "../plugins/workspace-references-field";
import { configField } from "./configuration";

/**
 * Whether a navigation stays inside the clicked document (same tab) or
 * targets another workspace document (reuse an existing tab or open one).
 */
export type ReferenceNavigationScope = "same-file" | "cross-file";

/**
 * The exact destination of one navigation: the defining document and the
 * range of the authored definition id token (for references) or of the
 * footnote ref body (for footnotes).
 */
export interface ReferenceNavigationTarget {
  documentPath: string;
  range: SourceRange;
}

/**
 * One resolved Mod-click navigation. `source` is the origin location
 * captured at jump time; Back must restore exactly this location.
 */
export interface ReferenceNavigationIntent {
  kind: "reference" | "footnote";
  scope: ReferenceNavigationScope;
  /** The authored reference key ('thm:torelli') or footnote label ('[^note]') */
  key: string;
  /** The supported reference family, or null for footnotes */
  family: ReferenceFamily | null;
  target: ReferenceNavigationTarget;
  source: DocumentLocation;
}

/**
 * The identity of the document shown in this view: the live workspace
 * reference snapshot's documentPath when the workspaceReferencesField is
 * populated, else the configured metadata path. Null when neither surface
 * names the document (no navigation is possible without an identity).
 *
 * @param   {EditorView}  view  The view
 *
 * @return  {string|null}       The current document path, or null
 */
function currentDocumentPath(view: EditorView): string | null {
  const references = view.state.field(workspaceReferencesField, false);
  if (references !== null && references !== undefined) {
    return references.snapshot.documentPath;
  }

  const config = view.state.field(configField, false);
  const path = config?.metadata.path ?? "";
  return path === "" ? null : path;
}

/**
 * Captures the restorable location of the given view: primary selection,
 * viewport scroll position, collapsed fold ranges, and source generation.
 *
 * The source generation is the synced document-authority (collab) version of
 * the state; editors without a document authority (e.g. the isolated probe
 * editors) define generation 0.
 */
export function captureDocumentLocation(
  view: EditorView,
  documentPath: string,
): DocumentLocation | null {
  const main = view.state.selection.main;

  const folds: SourceRange[] = [];
  const iterator = foldedRanges(view.state).iter();
  while (iterator.value !== null) {
    folds.push({ from: iterator.from, to: iterator.to });
    iterator.next();
  }

  let sourceGeneration = 0;
  try {
    sourceGeneration = getSyncedVersion(view.state);
  } catch (err) {
    // The state carries no collab field: this editor has no document
    // authority, and its source generation is defined as 0.
    sourceGeneration = 0;
  }

  return {
    documentPath,
    selection: { anchor: main.anchor, head: main.head },
    scrollTop: view.scrollDOM.scrollTop,
    folds,
    sourceGeneration,
  };
}

/**
 * Finds the enclosing node with the given name at pos, trying both boundary
 * sides (a click mapped through posAtCoords may land exactly on a node
 * boundary, e.g. at the edge of a replaced chip widget).
 */
function enclosingNode(view: EditorView, pos: number, name: string): SyntaxNode | null {
  for (const side of [1, -1] as const) {
    let node: SyntaxNode | null = syntaxTree(view.state).resolve(pos, side);
    while (node !== null && node.name !== name) {
      node = node.parent;
    }
    if (node !== null) {
      return node;
    }
  }
  return null;
}

/**
 * Resolves a reference (Citation) navigation intent: the clicked citekey (or
 * the preferred/first supported one for cluster-level clicks) resolved
 * through the workspaceReferencesField resolution map.
 */
function resolveCitationIntent(
  view: EditorView,
  citation: SyntaxNode,
  pos: number,
  documentPath: string,
  preferredKey?: string,
): ReferenceNavigationIntent | null {
  const references = view.state.field(workspaceReferencesField, false);
  if (references === null || references === undefined) {
    return null; // No workspace view: nothing can resolve.
  }

  // Collect the citekey children of the (flat) Citation node.
  const keyNodes: SyntaxNode[] = [];
  for (let child = citation.firstChild; child !== null; child = child.nextSibling) {
    if (child.type.name === NODES.KEY) {
      keyNodes.push(child);
    }
  }

  if (keyNodes.length === 0) {
    return null;
  }

  // Prefer the citekey the position actually falls on (including its @ sign);
  // for cluster-boundary clicks (chip widgets) fall back to the preferred key
  // (the clicked chip) or the first supported, resolved key.
  let chosen = keyNodes.find((node) => pos >= node.from - 1 && pos <= node.to);
  if (chosen === undefined && preferredKey !== undefined) {
    chosen = keyNodes.find((node) => view.state.sliceDoc(node.from, node.to) === preferredKey);
  }
  if (chosen === undefined) {
    chosen = keyNodes.find((node) => {
      const key = view.state.sliceDoc(node.from, node.to);
      if (referenceFamilyOf(key) === undefined) {
        return false;
      }
      return references.resolutions.get(key)?.status === "resolved";
    });
  }

  if (chosen === undefined) {
    return null;
  }

  const key = view.state.sliceDoc(chosen.from, chosen.to);
  const family = referenceFamilyOf(key);
  if (family === undefined) {
    return null; // Bibliography citations never navigate through this surface.
  }

  const resolution = references.resolutions.get(key);
  if (resolution === undefined || resolution.status !== "resolved") {
    return null; // Missing/duplicate keys have no single navigation target.
  }

  const { definition } = resolution;
  const source = captureDocumentLocation(view, documentPath);
  if (source === null) {
    return null;
  }

  return {
    kind: "reference",
    scope: definition.documentPath === documentPath ? "same-file" : "cross-file",
    key,
    family,
    target: {
      documentPath: definition.documentPath,
      range: { from: definition.range.from, to: definition.range.to },
    },
    source,
  };
}

/**
 * Resolves a footnote navigation intent: the [^label] ref follows to the
 * matching footnote body ([^label]: …) in the same document.
 */
function resolveFootnoteIntent(
  view: EditorView,
  footnote: SyntaxNode,
  documentPath: string,
): ReferenceNavigationIntent | null {
  const label = view.state.sliceDoc(footnote.from, footnote.to);
  if (label.startsWith("^[")) {
    return null; // Inline footnotes have no separate body to follow.
  }

  // Find the FootnoteRef whose label matches (same traversal the footnote
  // hover tooltip uses).
  let body: SourceRange | null = null;
  syntaxTree(view.state).iterate({
    enter(node) {
      if (node.name !== "FootnoteRef") {
        return;
      }

      const refLabel = node.node.getChild("FootnoteRefLabel");
      if (refLabel === null) {
        return false;
      }

      if (view.state.sliceDoc(refLabel.from, refLabel.to) !== label + ":") {
        return false; // Not the right one
      }

      body = { from: node.from, to: node.to };
    },
  });

  if (body === null) {
    return null;
  }

  const source = captureDocumentLocation(view, documentPath);
  if (source === null) {
    return null;
  }

  return {
    kind: "footnote",
    scope: "same-file",
    key: label,
    family: null,
    target: { documentPath, range: body },
    source,
  };
}

/**
 * Resolves the reference or footnote navigation intent at the given document
 * position, using the syntax tree for the clicked node and the
 * workspaceReferencesField resolutions for the definition target. Returns
 * null when the position carries no supported navigation target.
 *
 * @param   {EditorView}  view          The view
 * @param   {number}      pos           The clicked document position
 * @param   {string}      preferredKey  Optional: the authored key of the
 *                                      clicked chip, for cluster-boundary
 *                                      positions that cover several keys
 */
export function resolveReferenceNavigationIntent(
  view: EditorView,
  pos: number,
  preferredKey?: string,
): ReferenceNavigationIntent | null {
  const documentPath = currentDocumentPath(view);
  if (documentPath === null) {
    return null;
  }

  const citation = enclosingNode(view, pos, NODES.CITATION);
  if (citation !== null) {
    return resolveCitationIntent(view, citation, pos, documentPath, preferredKey);
  }

  const footnote = enclosingNode(view, pos, "Footnote");
  if (footnote !== null) {
    return resolveFootnoteIntent(view, footnote, documentPath);
  }

  return null;
}

/**
 * Follows a resolved navigation intent: same-file intents dispatch the
 * definition selection in the current view; cross-file intents send the
 * documents-provider 'open-file' request carrying the target range and the
 * captured source location. Returns true when the intent was followed.
 */
export function followReferenceNavigationIntent(
  view: EditorView,
  intent: ReferenceNavigationIntent,
): boolean {
  if (intent.scope === "same-file") {
    view.dispatch({
      selection: { anchor: intent.target.range.from, head: intent.target.range.to },
      effects: EditorView.scrollIntoView(intent.target.range.from, { y: "center" }),
    });
    return true;
  }

  // Cross-file: hand over to the documents provider, which owns tab
  // reuse/opening and the widened per-pane history (TabManager). A failed
  // handover surfaces through the recoverable boundary (review B8): one
  // closable error toast, never a silent console-only line.
  const { windowId, leafId } = view.state.facet(editorMetadataFacet);
  void runRecoverably(
    async () =>
      await window.ipc.invoke("documents-provider", {
        command: "open-file",
        payload: {
          path: intent.target.documentPath,
          windowId,
          leafId,
          // A reference jump must keep the origin tab open for Back.
          newTab: true,
          targetRange: intent.target.range,
          sourceLocation: intent.source,
        },
      } as DocumentManagerIPCAPI),
    trans("Following the reference"),
  );
  return true;
}

/**
 * Requests a per-pane history navigation from the documents provider,
 * sending the current DocumentLocation so the provider can stamp the current
 * history entry before moving (issue #1 Phase 5). Returns false when this
 * view carries no editor metadata (window/leaf), i.e. outside the main
 * editor.
 */
function requestHistoryNavigation(
  view: EditorView,
  command: "navigate-back" | "navigate-forward",
): boolean {
  const { windowId, leafId } = view.state.facet(editorMetadataFacet);
  if (windowId === undefined || leafId === undefined) {
    return false;
  }

  const documentPath = currentDocumentPath(view);
  const location =
    documentPath === null ? undefined : (captureDocumentLocation(view, documentPath) ?? undefined);
  // A failed history request surfaces through the recoverable boundary
  // (review B8): one closable error toast, never a silent console-only line.
  void runRecoverably(
    async () =>
      await window.ipc.invoke("documents-provider", {
        command,
        payload: { windowId, leafId, location },
      } as DocumentManagerIPCAPI),
    trans("History navigation"),
  );
  return true;
}

/**
 * Keymap command: navigate this pane one step back in its session history.
 */
export function navigateHistoryBack(view: EditorView): boolean {
  return requestHistoryNavigation(view, "navigate-back");
}

/**
 * Keymap command: navigate this pane one step forward in its session history.
 */
export function navigateHistoryForward(view: EditorView): boolean {
  return requestHistoryNavigation(view, "navigate-forward");
}
