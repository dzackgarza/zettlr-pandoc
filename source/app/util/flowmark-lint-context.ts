import { extractReferences } from "@common/pandoc-util/extract-references";
import { SEMANTIC_DIV_CLASSES } from "@common/pandoc-util/pandoc-div-model";
import { resolveWorkspace } from "@common/pandoc-util/resolve-references";
import {
  QUARTO_FAMILY_ALIASES,
  REFERENCEABLE_DIV_CLASSES,
  THEOREM_CLASS_TO_PREFIX,
  THEOREM_FAMILY_METADATA,
} from "@common/util/pandoc-quick-reference";
import {
  REFERENCE_FAMILIES,
  type DocumentReferenceSnapshot,
  type Resolution,
} from "@dts/common/references";
import type { WorkspaceReferenceState } from "@providers/references/reference-index";
import { wikilinkTargetsIn, type WikilinkIndex } from "@common/util/wikilink-resolution";
import { collectTikzCompilerFindings } from "./tikz-compiler-findings";
import { renderTikz, type TikzRenderConfig } from "tikz-workbench/src/tikz-render";

export interface FlowmarkLintContextSource {
  homeDirectory: string;
  env: NodeJS.ProcessEnv;
  macroSources: readonly string[];
  referenceState?: WorkspaceReferenceState;
  wikilinks?: WikilinkIndex;
  tikzRenderConfig: TikzRenderConfig;
}

export interface FlowmarkLintDocumentOptions {
  bibliographies?: string[];
  projectRoots?: string[];
}

/**
 * A resolution as Flowmark's reference rules read it: the status, and for a
 * duplicate the documents that define the key.
 */
type FlowmarkResolution =
  | { status: "resolved" | "missing" }
  | { status: "duplicate"; definitions: { documentPath: string }[] };

function flowmarkResolution(resolution: Resolution): FlowmarkResolution {
  if (resolution.status !== "duplicate") {
    return { status: resolution.status };
  }
  return {
    status: "duplicate",
    definitions: resolution.definitions.map((definition) => ({
      documentPath: definition.documentPath,
    })),
  };
}

/**
 * Every `key\0documentPath` definition site in the documents other than
 * `documentPath`, sorted. With the document's own text this fixes the
 * reference context Flowmark receives for it.
 */
export function otherDefinitionSites(
  referenceState: WorkspaceReferenceState,
  documentPath: string,
): string[] {
  return referenceState.snapshots
    .filter((snapshot) => snapshot.documentPath !== documentPath)
    .flatMap((snapshot) =>
      snapshot.definitions.map((definition) => `${definition.key}\0${snapshot.documentPath}`),
    )
    .sort();
}

function exactReferenceContext(
  documentPath: string,
  text: string,
  referenceState: WorkspaceReferenceState | undefined,
): { snapshot: ReturnType<typeof extractReferences>; resolutions: Record<string, FlowmarkResolution> } | undefined {
  if (referenceState === undefined) {
    return undefined;
  }
  const snapshot = extractReferences(documentPath, text);
  // Another document contributes only its definitions: its references add
  // only missing keys, which Flowmark's rules skip for any other document.
  const snapshots = referenceState.snapshots
    .filter((candidate) => candidate.documentPath !== documentPath)
    .map((candidate): DocumentReferenceSnapshot => ({ ...candidate, occurrences: [] }))
    .concat(snapshot);
  const resolutions: Record<string, FlowmarkResolution> = {};
  for (const [key, resolution] of resolveWorkspace(snapshots)) {
    resolutions[key] = flowmarkResolution(resolution);
  }
  return { snapshot, resolutions };
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

export async function buildFlowmarkLintContext(
  text: string,
  documentPath: string,
  source: FlowmarkLintContextSource,
  options: FlowmarkLintDocumentOptions = {},
): Promise<Record<string, unknown>> {
  const references = exactReferenceContext(documentPath, text, source.referenceState);
  const proofDivClasses = Object.entries(SEMANTIC_DIV_CLASSES)
    .filter(([, family]) => family === "proof")
    .map(([name]) => name);
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
      // Pandoc's default LaTeX template loads these for mathematical output.
      // Keep this host compile environment in context rather than pretending
      // AMS commands are TeX/LaTeX core in Flowmark.
      packages: ["amsmath", "amssymb"],
    },
    references: {
      reference_families: [...REFERENCE_FAMILIES],
      theorem_families: THEOREM_FAMILY_METADATA.map((metadata) => metadata.prefix),
      family_aliases: Object.fromEntries(
        QUARTO_FAMILY_ALIASES.map((alias) => [alias.prefix, alias.family]),
      ),
      referenceable_div_classes: [...REFERENCEABLE_DIV_CLASSES],
      proof_div_classes: proofDivClasses,
      theorem_class_to_prefix: { ...THEOREM_CLASS_TO_PREFIX },
      ...(options.bibliographies === undefined ? {} : { bibliographies: options.bibliographies }),
      ...(references === undefined ? {} : references),
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
