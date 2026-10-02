/**
 * Mounts the production reference hover tooltip for isolated visual capture
 * (issue #1 Phase 4; ledger C4 adds the expanded frame and the
 * another-Project status scene). Follows the
 * editor-pandoc-div-visual-entry.ts pattern: the tooltip spec produced by
 * the real referenceTooltip source is presented through CodeMirror's own
 * tooltip machinery (showTooltip), so position, clipping, and theming match
 * the production hover surface.
 *
 * Scenes (body.dataset.scene):
 * - 'resolved' (default): hover on @thm:torelli without projectRoots — no
 *   status row; the theorem body is long enough that the collapsed excerpt
 *   genuinely clips, so the capture driver's Expand click shows real
 *   additional content.
 * - 'another-project': the same workspace WITH projectRoots fed; hover on
 *   the occurrence resolving into ProjectB, so the tooltip renders its
 *   Project-status row ("Another Project").
 */

import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { EditorView, showTooltip, type Tooltip } from "@codemirror/view";
import type { ProjectRootSpec } from "@dts/common/references";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";
import {
  type EditorWorkspaceReferences,
  workspaceReferencesField,
  workspaceReferencesUpdate,
} from "source/common/modules/markdown-editor/plugins/workspace-references-field";
import {
  defaultDark,
  defaultLight,
  editorTheme,
} from "source/common/modules/markdown-editor/theme/editor";
import {
  referenceTooltip,
  referenceTooltips,
} from "source/common/modules/markdown-editor/tooltips/references";
import { configField } from "source/common/modules/markdown-editor/util/configuration";
import { extractReferences } from "source/common/pandoc-util/extract-references";
import { resolveWorkspace } from "source/common/pandoc-util/resolve-references";

declare global {
  interface Window {
    captureReady: Promise<void>;
  }
}

// The theorem body is deliberately long: the collapsed excerpt is bounded to
// 10em, so the Expand toggle has real hidden content to reveal.
const definitions = `# Structural results

## Main results

::: {.theorem #thm:torelli title="Torelli for Enriques"}
Two complex Enriques surfaces are isomorphic if and only if their period
points agree in the quotient of the type IV domain by the stable orthogonal
group of the Enriques lattice.

The marked refinement records, in addition, an isometry of the numerical
lattices intertwining the period maps; two marked surfaces are isomorphic
as marked surfaces exactly when the periods agree before taking the
quotient.

The proof proceeds by degenerating to a Halphen pencil of index two,
applying the strong Torelli theorem for the K3 cover, and descending the
resulting Hodge isometry through the Enriques involution, which pins the
polarization data on each half-fiber of the elliptic fibration.
:::
`;

const otherPaper = `# Companion paper

::: {.lemma #lem:kodaira:embedding title="Kodaira embedding for Halphen pencils"}
The linear system of a Halphen pencil of index two embeds the blown-up
plane whenever the nine base points are in general position.
:::
`;

const citing = `# Halphen surfaces of index two

A Halphen surface of index two arises from a pencil of plane sextics with
nine double base points.

Restricting to a half-fiber, the nef cone is cut out by the roots of the
Coble lattice, one wall for each primitive isotropic vector.

The wall-and-chamber decomposition refines under the marking, and each
chamber carries a distinguished ample class whose square grows with the
index of the pencil.

The period-theoretic input is @thm:torelli, which pins down the marked
isomorphism class of the surface together with its polarization data.

The embedding step relies on @lem:kodaira:embedding for the ample linear
system of the blown-up plane.
`;

const PROJECT_ROOTS: ProjectRootSpec[] = [
  {
    rootPath: "ProjectA",
    files: ["Theorems.md", "Halphen_Surfaces.md"],
  },
  {
    rootPath: "ProjectB",
    files: ["Other_Paper.md"],
  },
];

const setTooltip = StateEffect.define<Tooltip | null>();

const pinnedTooltip = StateField.define<Tooltip | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setTooltip)) {
        return effect.value;
      }
    }
    return value;
  },
  provide: (f) => showTooltip.from(f),
});

async function mount(): Promise<void> {
  window.getCitationCallback = () => (citations) =>
    citations
      .map((citation) => {
        return [citation.id, citation.locator, citation.suffix?.trimStart()]
          .filter((part) => part !== undefined)
          .join(" ");
      })
      .join("; ");

  const dark = document.body.dataset.dark === "true";
  const scene = document.body.dataset.scene ?? "resolved";
  const doc = citing;

  const definitionsSnapshot = extractReferences("ProjectA/Theorems.md", definitions);
  const otherSnapshot = extractReferences("ProjectB/Other_Paper.md", otherPaper);
  const citingSnapshot = extractReferences("ProjectA/Halphen_Surfaces.md", doc);
  const workspace = [definitionsSnapshot, otherSnapshot, citingSnapshot];
  const payload: EditorWorkspaceReferences = {
    snapshot: citingSnapshot,
    workspaceOccurrences: workspace.flatMap((s) => s.occurrences),
    resolutions: resolveWorkspace(workspace),
  };
  if (scene === "another-project") {
    // The status row renders only while the view carries projectRoots.
    payload.projectRoots = PROJECT_ROOTS;
  }

  const state = EditorState.create({
    doc,
    selection: { anchor: 0 },
    extensions: [
      markdownParser(),
      configField,
      EditorView.lineWrapping,
      editorTheme,
      dark ? defaultDark : defaultLight,
      workspaceReferencesField,
      referenceTooltips,
      pinnedTooltip,
    ],
  });

  const host = document.querySelector<HTMLElement>("#editor");
  if (host === null) {
    throw new Error("Visual capture host is missing");
  }

  const view = new EditorView({ state, parent: host });
  view.dispatch({ effects: workspaceReferencesUpdate.of(payload) });

  const hoverToken = scene === "another-project" ? "@lem:kodaira:embedding" : "@thm:torelli";
  const hoverPos = doc.indexOf(hoverToken) + 3;
  const tooltip = referenceTooltip(view, hoverPos, 1);
  if (tooltip === null) {
    throw new Error("The resolved occurrence must produce a hover tooltip");
  }
  view.dispatch({ effects: setTooltip.of(tooltip) });

  await document.fonts.ready;
  // Give the tooltip its layout cycle and the excerpt its rendering pass.
  await new Promise<void>((resolve) => setTimeout(resolve, 200));
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

window.captureReady = mount();
