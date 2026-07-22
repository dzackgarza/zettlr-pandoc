/**
 * Mounts the production reference chip and definition badge presentation for
 * isolated visual capture (issue #1 Phase 4). Follows the
 * editor-pandoc-div-visual-entry.ts pattern.
 */

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { renderCitations } from 'source/common/modules/markdown-editor/renderers/render-citations'
import { renderEmphasis } from 'source/common/modules/markdown-editor/renderers/render-emphasis'
import { renderReferenceChips } from 'source/common/modules/markdown-editor/renderers/render-reference-chips'
import { renderReferenceDefinitions } from 'source/common/modules/markdown-editor/renderers/render-reference-definitions'
import {
  workspaceReferencesField,
  workspaceReferencesUpdate,
  type EditorWorkspaceReferences
} from 'source/common/modules/markdown-editor/plugins/workspace-references-field'
import { defaultDark, defaultLight, editorTheme } from 'source/common/modules/markdown-editor/theme/editor'
import { configField } from 'source/common/modules/markdown-editor/util/configuration'
import { extractReferences } from 'source/common/pandoc-util/extract-references'
import { resolveWorkspace } from 'source/common/pandoc-util/resolve-references'
import type { ProjectRootSpec } from '@dts/common/references'

declare global {
  interface Window {
    captureReady: Promise<void>
  }
}

/** The workspace document defining the crossref and theorem targets. */
const definitions = `# Coble lattices and rational surfaces

## Moduli of marked surfaces {#sec:moduli}

::: {.theorem #thm:torelli title="Torelli for Enriques"}
Two complex Enriques surfaces are isomorphic if and only if their period
points agree in the quotient of the type IV domain.
:::

| Lattice              | Signature | Discriminant group     |
|----------------------|-----------|------------------------|
| $U$                  | $(1,1)$   | trivial                |
| $E_{10}$             | $(1,9)$   | trivial                |

: Coble lattices of Halphen type {#tbl:coble-lattices}

$$ q(x) = x^2 $$ {#eq:intersection-form}

![Root diagram](roots.png){#fig:root-diagram}

\`\`\`{#lst:sage-run .python caption="Sage session"}
L = IntegralLattice("U").direct_sum(IntegralLattice("E8").twist(2))
\`\`\`
`

/** The citing document: chips, preserved punctuation, raw fallbacks. */
const occurrences = `# Halphen surfaces of index two

The fibration data is summarized in @tbl:coble-lattices, and the
period-theoretic input is [see @thm:torelli; @eq:intersection-form], which
pins down the marked isomorphism class.

See [@fig:root-diagram] for the roots and [@eq:intersection-form, p. 3] for
the squares of effective classes near @sec:moduli.

The picture in @fig:nonexistent-diagram is unfinished, so it stays raw.

Combine [@thm:torelli; @Ols04, Lem. 7.1] for the argument: the mixed cluster
stays raw as well.

For the construction of the pencil see [@Ols04, Lem. 7.1].
`

// ——— The resolution-states scene (ledger C4): a two-Project workspace in
// which thm:torelli is defined in BOTH Projects (duplicate — the occurrence
// stays raw per contract), fig:missing is defined nowhere (raw), and the
// remaining keys resolve — one inside the active Project and one into
// ProjectB (whose chip renders normally; the STATUS surfaces belong to the
// hover tooltip and the completion popup).

const stateDefinitionsA = `# Structural results

::: {.theorem #thm:torelli title="Torelli for Enriques"}
Two complex Enriques surfaces are isomorphic if and only if their period
points agree in the quotient of the type IV domain.
:::

$$ q(x) = x^2 $$ {#eq:intersection-form}
`

const stateDefinitionsB = `# Companion paper

::: {.theorem #thm:torelli title="Torelli, companion restatement"}
The companion draft restates the Torelli theorem under its own numbering,
which makes the key a workspace duplicate.
:::

::: {.lemma #lem:halphen-degeneration title="Halphen degenerations"}
Every Halphen pencil of index two degenerates to a union of two rational
elliptic surfaces glued along a half-fiber.
:::
`

const stateOccurrences = `# Reference resolution states

The intersection form @eq:intersection-form resolves inside the active
Project, so its occurrence renders as a chip.

The duplicate key @thm:torelli is defined in BOTH Projects, so the
occurrence stays raw — diagnostics own that state and no definition is
selected silently.

The missing key @fig:missing has no definition anywhere in the workspace,
so it stays raw as well.

The outside key @lem:halphen-degeneration resolves into ProjectB, so its
chip renders normally.
`

const STATE_PROJECT_ROOTS: ProjectRootSpec[] = [
  {
    rootPath: 'ProjectA',
    files: [ 'Definitions.md', 'States.md' ],
  },
  {
    rootPath: 'ProjectB',
    files: ['Other_Paper.md'],
  },
]

function statesPayload (): EditorWorkspaceReferences {
  const workspace = [
    extractReferences('ProjectA/Definitions.md', stateDefinitionsA),
    extractReferences('ProjectB/Other_Paper.md', stateDefinitionsB),
    extractReferences('ProjectA/States.md', stateOccurrences)
  ]
  const snapshot = workspace[2]
  return {
    snapshot,
    workspaceOccurrences: workspace.flatMap(s => s.occurrences),
    resolutions: resolveWorkspace(workspace),
    projectRoots: STATE_PROJECT_ROOTS
  }
}

function payloadFor (documentPath: string): EditorWorkspaceReferences {
  const workspace = [
    extractReferences('definitions.md', definitions),
    extractReferences('occurrences.md', occurrences)
  ]
  const snapshot = workspace.find(candidate => candidate.documentPath === documentPath)
  if (snapshot === undefined) {
    throw new Error(`Unknown capture document: ${documentPath}`)
  }
  return {
    snapshot,
    workspaceOccurrences: workspace.flatMap(s => s.occurrences),
    resolutions: resolveWorkspace(workspace)
  }
}

async function mount (): Promise<void> {
  window.getCitationCallback = () => citations => citations.map(citation => {
    return [ citation.id, citation.locator, citation.suffix?.trimStart() ]
      .filter(part => part !== undefined)
      .join(' ')
  }).join('; ')

  const scene = document.body.dataset.scene ?? 'occurrences'
  const dark = document.body.dataset.dark === 'true'
  const documentPath = scene === 'definitions' ? 'definitions.md' : 'occurrences.md'
  const doc = scene === 'states' ? stateOccurrences : scene === 'definitions' ? definitions : occurrences

  const state = EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [
      markdownParser(),
      configField,
      EditorView.lineWrapping,
      editorTheme,
      dark ? defaultDark : defaultLight,
      renderCitations,
      renderReferenceChips,
      renderReferenceDefinitions,
      renderEmphasis,
      workspaceReferencesField,
    ],
  })

  const host = document.querySelector<HTMLElement>('#editor')
  if (host === null) {
    throw new Error('Visual capture host is missing')
  }

  const view = new EditorView({ state, parent: host })
  view.dispatch({
    effects: workspaceReferencesUpdate.of(scene === 'states' ? statesPayload() : payloadFor(documentPath))
  })
  await document.fonts.ready
  // Give the badge layer its measure cycle before capturing.
  for (let i = 0; i < 3; i++) {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  }
}

window.captureReady = mount()
