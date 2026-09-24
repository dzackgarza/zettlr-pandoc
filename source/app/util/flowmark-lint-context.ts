import { extractReferences } from "@common/pandoc-util/extract-references";
import { SEMANTIC_DIV_CLASSES } from "@common/pandoc-util/pandoc-div-model";
import { resolveWorkspace } from "@common/pandoc-util/resolve-references";
import {
  QUARTO_FAMILY_ALIASES,
  REFERENCEABLE_DIV_CLASSES,
  THEOREM_CLASS_TO_PREFIX,
  THEOREM_FAMILY_METADATA,
} from "@common/util/pandoc-quick-reference";
import { REFERENCE_FAMILIES } from "@dts/common/references";
import type { WorkspaceReferenceState } from "@providers/references/reference-index";
import { collectTikzCompilerFindings } from "./tikz-compiler-findings";
import { renderTikz, type TikzRenderConfig } from "./tikz-render";

export interface FlowmarkLintContextSource {
  homeDirectory: string;
  env: NodeJS.ProcessEnv;
  macroSources: readonly string[];
  referenceState?: WorkspaceReferenceState;
  tikzRenderConfig: TikzRenderConfig;
}

export interface FlowmarkLintDocumentOptions {
  bibliographies?: string[];
  projectRoots?: string[];
}

function exactReferenceContext(
  documentPath: string,
  text: string,
  referenceState: WorkspaceReferenceState | undefined,
): { snapshot: ReturnType<typeof extractReferences>; resolutions: Record<string, unknown> } | undefined {
  if (referenceState === undefined) {
    return undefined;
  }
  const snapshot = extractReferences(documentPath, text);
  const snapshots = referenceState.snapshots
    .filter((candidate) => candidate.documentPath !== documentPath)
    .concat(snapshot);
  return {
    snapshot,
    resolutions: Object.fromEntries(resolveWorkspace(snapshots)),
  };
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
      texinputs: source.env.TEXINPUTS ?? "",
      project_roots: options.projectRoots ?? [],
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
    compiler: {
      tikz: {
        diagnostics: tikzCompileDiagnostics,
      },
    },
  };
}
