import { extractReferences, hashDocumentSource } from "@common/pandoc-util/extract-references";
import { SEMANTIC_DIV_CLASSES } from "@common/pandoc-util/pandoc-div-model";
import {
  QUARTO_FAMILY_ALIASES,
  REFERENCEABLE_DIV_CLASSES,
  THEOREM_CLASS_TO_PREFIX,
  THEOREM_FAMILY_METADATA,
} from "@common/util/pandoc-quick-reference";
import {
  REFERENCE_FAMILIES,
  type DocumentReferenceSnapshot,
  type ReferenceDefinition,
  type ReferenceOccurrence,
} from "@dts/common/references";
import type { WorkspaceReferenceState } from "@providers/references/reference-index";
import { wikilinkTargetsIn, type WikilinkIndex } from "@common/util/wikilink-resolution";
import { collectTikzCompilerFindings } from "./tikz-compiler-findings";
import { renderTikz, type TikzRenderConfig } from "tikz-workbench/src/tikz-render";

export interface FlowmarkLintContextSource {
  homeDirectory: string;
  env: NodeJS.ProcessEnv;
  macroSources: readonly string[];
  wikilinks?: WikilinkIndex;
  tikzRenderConfig: TikzRenderConfig;
}

export interface FlowmarkLintDocumentOptions {
  bibliographies?: string[];
  projectRoots?: string[];
  /** Absent when no workspace reference state exists. */
  references?: FlowmarkReferenceContext;
}

/**
 * A resolution as Flowmark's reference rules read it: the status, and for a
 * duplicate the documents that define the key.
 */
type FlowmarkResolution =
  | { status: "resolved" | "missing" }
  | { status: "duplicate"; definitions: { documentPath: string }[] };

/**
 * The reference data Flowmark receives for one document: the definitions and
 * references of its text, and the workspace resolution of each key that the
 * document defines or references. When one of its references has no
 * definition, the resolutions also hold every other key that the workspace
 * defines, from which Flowmark suggests a replacement.
 */
export interface FlowmarkReferenceContext {
  snapshot: {
    documentPath: string;
    sourceHash: string;
    definitions: ReferenceDefinition[];
    occurrences: ReferenceOccurrence[];
  };
  resolutions: Record<string, FlowmarkResolution>;
}

/** The definitions of a workspace, indexed for the documents of one lint pass. */
export interface WorkspaceDefinitions {
  /** The documents that define each key, one entry for each definition. */
  sites: ReadonlyMap<string, readonly string[]>;
  snapshots: ReadonlyMap<string, DocumentReferenceSnapshot>;
}

export function workspaceDefinitions(referenceState: WorkspaceReferenceState): WorkspaceDefinitions {
  const sites = new Map<string, string[]>();
  const snapshots = new Map<string, DocumentReferenceSnapshot>();
  for (const snapshot of referenceState.snapshots) {
    snapshots.set(snapshot.documentPath, snapshot);
    for (const definition of snapshot.definitions) {
      const known = sites.get(definition.key);
      if (known === undefined) {
        sites.set(definition.key, [snapshot.documentPath]);
      } else {
        known.push(snapshot.documentPath);
      }
    }
  }
  return { sites, snapshots };
}

export function flowmarkReferenceContext(
  documentPath: string,
  text: string,
  workspace: WorkspaceDefinitions,
): FlowmarkReferenceContext {
  // The workspace snapshot of the document is the extraction of its text
  // when the two hashes agree; any other text is extracted here.
  const known = workspace.snapshots.get(documentPath);
  const { sourceHash, definitions, occurrences } = known?.sourceHash === hashDocumentSource(text)
    ? known
    : extractReferences(documentPath, text);
  const ownSites = new Map<string, string[]>();
  for (const definition of definitions) {
    const sites = ownSites.get(definition.key);
    if (sites === undefined) {
      ownSites.set(definition.key, [documentPath]);
    } else {
      sites.push(documentPath);
    }
  }
  // The text decides what this document defines; the workspace decides what
  // every other document defines. A key that neither map holds has no
  // definition site.
  const resolve = (key: string): FlowmarkResolution => {
    const workspaceSites = workspace.sites.get(key);
    const own = ownSites.get(key);
    const sites = [
      ...(workspaceSites === undefined ? [] : workspaceSites.filter((site) => site !== documentPath)),
      ...(own === undefined ? [] : own),
    ].sort();
    if (sites.length === 0) {
      return { status: "missing" };
    }
    if (sites.length === 1) {
      return { status: "resolved" };
    }
    return { status: "duplicate", definitions: sites.map((site) => ({ documentPath: site })) };
  };
  const keys = new Set([...ownSites.keys(), ...occurrences.map((occurrence) => occurrence.key)]);
  const resolved = new Map([...keys].map((key): [string, FlowmarkResolution] => [key, resolve(key)]));
  if ([...resolved.values()].some((resolution) => resolution.status === "missing")) {
    for (const key of workspace.sites.keys()) {
      const resolution = resolved.get(key) ?? resolve(key);
      if (resolution.status !== "missing") {
        resolved.set(key, resolution);
      }
    }
  }
  // Sorted keys: the same data has one serialization, and one digest.
  const resolutions = Object.fromEntries([...resolved].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { snapshot: { documentPath, sourceHash, definitions, occurrences }, resolutions };
}

/**
 * How each wikilink target in `text` resolves in the workspace, keyed by the
 * target before its `#` fragment and `|` label. Flowmark reports the missing,
 * ambiguous and document-relative ones from this.
 */
export type FlowmarkWikilinkResolution =
  | { status: "resolved"; path: string; canonical: string; relative: boolean }
  | { status: "ambiguous"; candidates: { path: string; canonical: string }[] }
  | { status: "missing" };

export function wikilinkResolutions(
  text: string,
  documentPath: string,
  index: WikilinkIndex,
): Record<string, FlowmarkWikilinkResolution> {
  return Object.fromEntries(wikilinkTargetsIn(text).map((target): [string, FlowmarkWikilinkResolution] => {
    const resolution = index.resolve(target, documentPath);
    if (resolution.status !== "ambiguous") {
      return [target, resolution];
    }
    return [target, {
      status: "ambiguous",
      candidates: resolution.candidates.map((path) => ({ path, canonical: index.canonical(path) })),
    }];
  }));
}

/**
 * The part of the Flowmark context that this app fixes: the packages of the
 * host compile environment and the reference vocabulary. It is an input of
 * every lint, so the lint cache keys results by it.
 */
export const FLOWMARK_HOST_VOCABULARY = {
  // Pandoc's default LaTeX template loads these for mathematical output.
  // Keep this host compile environment in context rather than pretending
  // AMS commands are TeX/LaTeX core in Flowmark.
  packages: ["amsmath", "amssymb"],
  references: {
    reference_families: [...REFERENCE_FAMILIES],
    theorem_families: THEOREM_FAMILY_METADATA.map((metadata) => metadata.prefix),
    family_aliases: Object.fromEntries(
      QUARTO_FAMILY_ALIASES.map((alias) => [alias.prefix, alias.family]),
    ),
    referenceable_div_classes: [...REFERENCEABLE_DIV_CLASSES],
    proof_div_classes: Object.entries(SEMANTIC_DIV_CLASSES)
      .filter(([, family]) => family === "proof")
      .map(([name]) => name),
    theorem_class_to_prefix: { ...THEOREM_CLASS_TO_PREFIX },
  },
};

export async function buildFlowmarkLintContext(
  text: string,
  documentPath: string,
  source: FlowmarkLintContextSource,
  options: FlowmarkLintDocumentOptions = {},
): Promise<Record<string, unknown>> {
  const tikzCompileDiagnostics = await collectTikzCompilerFindings(
    text,
    documentPath,
    async (request) => await renderTikz(request, source.tikzRenderConfig),
  );

  return {
    tex: {
      home_directory: source.homeDirectory,
      // Absent keys mean "not set": an unset TEXINPUTS leaves TeX's own
      // search path, and a document outside any project has no project root.
      ...(source.env.TEXINPUTS === undefined ? {} : { texinputs: source.env.TEXINPUTS }),
      ...(options.projectRoots === undefined ? {} : { project_roots: options.projectRoots }),
      macro_sources: [...source.macroSources],
      packages: [...FLOWMARK_HOST_VOCABULARY.packages],
    },
    references: {
      ...FLOWMARK_HOST_VOCABULARY.references,
      ...(options.bibliographies === undefined ? {} : { bibliographies: options.bibliographies }),
      ...(options.references === undefined ? {} : options.references),
    },
    ...(source.wikilinks === undefined
      ? {}
      : { wikilinks: { resolutions: wikilinkResolutions(text, documentPath, source.wikilinks) } }),
    compiler: {
      tikz: {
        diagnostics: tikzCompileDiagnostics,
      },
    },
  };
}
