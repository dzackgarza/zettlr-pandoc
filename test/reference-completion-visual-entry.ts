/**
 * Mounts the production combined `@` completion surface for isolated visual
 * capture (issue #1, ledger C4). Follows the
 * editor-reference-chips-visual-entry.ts pattern: a REAL EditorView carries
 * the PRODUCTION autocomplete extension array (autocomplete/index.ts with
 * atSymbols in the citations slot), the citation and references databases
 * are fed through their production effects, and startCompletion() opens the
 * real tooltip DOM — nothing is mocked or re-implemented.
 *
 * The capture driver (reference-completion-visual-capture.cjs) uses the
 * exposed completionProbe* helpers to select specific options (for the
 * label info panel with its quick-help link and for the disabled
 * another-Project entry) and to prove the disabled entry's inert apply.
 */

import {
  acceptCompletion,
  currentCompletions,
  moveCompletionSelection,
  selectedCompletion,
  startCompletion,
} from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { ProjectRootSpec, ReferenceCompletionEntry } from "@dts/common/references";
import {
  autocomplete,
  citekeyUpdate,
  referencesUpdate,
} from "source/common/modules/markdown-editor/autocomplete";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";
import {
  defaultDark,
  defaultLight,
  editorTheme,
} from "source/common/modules/markdown-editor/theme/editor";
import { configField } from "source/common/modules/markdown-editor/util/configuration";
import { extractReferences } from "source/common/pandoc-util/extract-references";
import { annotateCompletionEntries } from "source/common/pandoc-util/project-reference-status";

declare global {
  interface Window {
    captureReady: Promise<void>;
    /** Moves the completion selection to the option with this label. */
    completionProbeSelect: (
      label: string,
    ) => Promise<{ selected: boolean; seen: Array<string | null> }>;
    /** The labels of every option on the open surface, in order. */
    completionProbeOptionLabels: () => string[];
    /** Accepts the selected option and reports the resulting document. */
    completionProbeAccept: () => string;
    /** The current document text. */
    completionProbeDoc: () => string;
  }
}

/** The bibliography database, as MainEditor.vue would push it. */
const CITATION_DB = [
  {
    citekey: "Ols04",
    displayText: "Olsson — Semistable degenerations and period spaces for polarized K3 surfaces",
  },
  { citekey: "Kod63", displayText: "Kodaira — On compact analytic surfaces II" },
  { citekey: "BHPV04", displayText: "Barth, Hulek, Peters, Van de Ven — Compact complex surfaces" },
];

/** ProjectA definitions: same-file/in-active-Project label entries. */
const theorems = `# Structural results

::: {.theorem #thm:torelli title="Torelli for Enriques"}
Two complex Enriques surfaces are isomorphic if and only if their period
points agree in the quotient of the type IV domain.
:::

$$ q(x) = x^2 $$ {#eq:intersection-form}
`;

const cobleTable = `# Coble lattices

| Lattice | Signature |
|---------|-----------|
| $U$     | $(1,1)$   |

: Coble lattices of Halphen type {#tbl:coble-lattices}
`;

/** The ProjectB definition: the disabled another-Project entry. */
const otherPaper = `# Companion paper

::: {.lemma #lem:kodaira:embedding title="Kodaira embedding for Halphen pencils"}
The linear system of a Halphen pencil of index two embeds the blown-up
plane whenever the base points are in general position.
:::
`;

/** The citing document being edited: the completion opens after its \`@\`. */
const citing = `# Halphen surfaces of index two

A Halphen surface of index two arises from a pencil of plane sextics with
nine double base points.

The period-theoretic input is @`;

const ACTIVE_PATH = "ProjectA/Halphen_Surfaces.md";

const PROJECT_ROOTS: ProjectRootSpec[] = [
  {
    rootPath: "ProjectA",
    files: ["Theorems.md", "Coble_Lattice_Table.md", "Halphen_Surfaces.md"],
  },
  {
    rootPath: "ProjectB",
    files: ["Other_Paper.md"],
  },
];

/** Every workspace definition as an annotated 'references' database entry. */
function workspaceEntries(): ReferenceCompletionEntry[] {
  const workspace = [
    extractReferences("ProjectA/Theorems.md", theorems),
    extractReferences("ProjectA/Coble_Lattice_Table.md", cobleTable),
    extractReferences("ProjectB/Other_Paper.md", otherPaper),
  ];
  const raw = workspace.flatMap((snapshot) =>
    snapshot.definitions.map((definition) => ({
      key: definition.key,
      family: definition.family,
      title: definition.title,
      documentPath: definition.documentPath,
    })),
  );
  return annotateCompletionEntries(raw, ACTIVE_PATH, PROJECT_ROOTS);
}

let view: EditorView;

async function mount(): Promise<void> {
  const dark = document.body.dataset.dark === "true";

  const state = EditorState.create({
    doc: citing,
    selection: { anchor: citing.length },
    extensions: [
      markdownParser(),
      configField,
      EditorView.lineWrapping,
      editorTheme,
      dark ? defaultDark : defaultLight,
      autocomplete,
    ],
  });

  const host = document.querySelector<HTMLElement>("#editor");
  if (host === null) {
    throw new Error("Visual capture host is missing");
  }

  view = new EditorView({ state, parent: host });
  view.dispatch({ effects: citekeyUpdate.of(CITATION_DB) });
  view.dispatch({ effects: referencesUpdate.of(workspaceEntries()) });

  await document.fonts.ready;
  view.focus();
  startCompletion(view);

  // The completion surface opens asynchronously; wait for the real tooltip
  // DOM rather than a fixed delay, and fail loudly if it never appears.
  for (let i = 0; i < 100; i++) {
    if (document.querySelector(".cm-tooltip-autocomplete") !== null) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The completion tooltip never appeared");
}

window.completionProbeOptionLabels = () => {
  return currentCompletions(view.state).map((option) => option.label);
};

window.completionProbeSelect = async (
  label: string,
): Promise<{ selected: boolean; seen: Array<string | null> }> => {
  const seen: Array<string | null> = [];
  for (let i = 0; i < 20; i++) {
    const current = selectedCompletion(view.state)?.label ?? null;
    seen.push(current);
    if (current === label) {
      return { selected: true, seen };
    }
    moveCompletionSelection(true)(view);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  return { selected: false, seen };
};

window.completionProbeAccept = (): string => {
  acceptCompletion(view);
  return view.state.doc.toString();
};

window.completionProbeDoc = (): string => {
  return view.state.doc.toString();
};

window.captureReady = mount();
