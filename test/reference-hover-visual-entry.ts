/**
 * Mounts the production reference hover tooltip for isolated visual capture
 * (issue #1 Phase 4). Follows the editor-pandoc-div-visual-entry.ts pattern:
 * the tooltip spec produced by the real referenceTooltip source is presented
 * through CodeMirror's own tooltip machinery (showTooltip), so position,
 * clipping, and theming match the production hover surface.
 */

import { EditorState, StateEffect, StateField } from '@codemirror/state'
import { EditorView, showTooltip, type Tooltip } from '@codemirror/view'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { referenceTooltip, referenceTooltips } from 'source/common/modules/markdown-editor/tooltips/references'
import {
  workspaceReferencesField,
  workspaceReferencesUpdate,
  type EditorWorkspaceReferences
} from 'source/common/modules/markdown-editor/plugins/workspace-references-field'
import { defaultDark, defaultLight, editorTheme } from 'source/common/modules/markdown-editor/theme/editor'
import { configField } from 'source/common/modules/markdown-editor/util/configuration'
import { extractReferences } from 'source/common/pandoc-util/extract-references'
import { resolveWorkspace } from 'source/common/pandoc-util/resolve-references'

declare global {
  interface Window {
    captureReady: Promise<void>
  }
}

const definitions = `# Structural results

## Main results

::: {.theorem #thm:torelli title="Torelli for Enriques"}
Two complex Enriques surfaces are isomorphic if and only if their period
points agree in the quotient of the type IV domain by the stable orthogonal
group of the Enriques lattice.
:::
`

const citing = `# Halphen surfaces of index two

A Halphen surface of index two arises from a pencil of plane sextics with
nine double base points.

The period-theoretic input is @thm:torelli, which pins down the marked
isomorphism class of the surface together with its polarization data.

Restricting to a half-fiber, the nef cone is cut out by the roots of the
Coble lattice, one wall for each primitive isotropic vector.
`

const setTooltip = StateEffect.define<Tooltip|null>()

const pinnedTooltip = StateField.define<Tooltip|null>({
  create: () => null,
  update (value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setTooltip)) {
        return effect.value
      }
    }
    return value
  },
  provide: f => showTooltip.from(f)
})

async function mount (): Promise<void> {
  window.getCitationCallback = () => citations => citations.map(citation => {
    return [ citation.id, citation.locator, citation.suffix?.trimStart() ]
      .filter(part => part !== undefined)
      .join(' ')
  }).join('; ')

  const dark = document.body.dataset.dark === 'true'
  const doc = citing

  const definitionsSnapshot = extractReferences('ProjectA/Theorems.md', definitions)
  const citingSnapshot = extractReferences('ProjectA/Halphen_Surfaces.md', doc)
  const workspace = [ definitionsSnapshot, citingSnapshot ]
  const payload: EditorWorkspaceReferences = {
    snapshot: citingSnapshot,
    workspaceOccurrences: workspace.flatMap(s => s.occurrences),
    resolutions: resolveWorkspace(workspace)
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
  })

  const host = document.querySelector<HTMLElement>('#editor')
  if (host === null) {
    throw new Error('Visual capture host is missing')
  }

  const view = new EditorView({ state, parent: host })
  view.dispatch({ effects: workspaceReferencesUpdate.of(payload) })

  const hoverPos = doc.indexOf('@thm:torelli') + 3
  const tooltip = referenceTooltip(view, hoverPos, 1)
  if (tooltip === null) {
    throw new Error('The resolved occurrence must produce a hover tooltip')
  }
  view.dispatch({ effects: setTooltip.of(tooltip) })

  await document.fonts.ready
  // Give the tooltip its layout cycle and the excerpt its rendering pass.
  await new Promise<void>(resolve => setTimeout(resolve, 200))
  for (let i = 0; i < 3; i++) {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  }
}

window.captureReady = mount()
