/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikZ RHS preview provider registry
 * CVM-Role:        View registry
 * License:         GNU GPL v3
 *
 * Description:     Binds domain-level preview-mode descriptors to renderer
 *                  components. TikzLivePreview consumes only this registry;
 *                  adding a new preview/editor no longer requires another
 *                  conditional rendering branch in the sidecar.
 *
 * END HEADER
 */

import type { Component } from 'vue'
import {
  TIKZ_PREVIEW_MODES,
  type TikzPreviewModeDescriptor,
  type TikzPreviewModeId
} from '@common/modules/markdown-editor/tikz-preview-modes'
import TikzCompilerPreview from './TikzCompilerPreview.vue'
import TikzQuiverPreview from './TikzQuiverPreview.vue'

export interface TikzPreviewProvider extends TikzPreviewModeDescriptor {
  component: Component
}

const COMPONENTS: Record<Exclude<TikzPreviewModeId, 'visual'>, Component> = {
  tikz: TikzCompilerPreview,
  quiver: TikzQuiverPreview
}

// Visual is registered by TikzVisualPreview once that provider exists. Keeping
// the domain descriptor present now lets capability tests lock its exact scope
// independently of the view implementation.
export const TIKZ_PREVIEW_PROVIDERS: readonly TikzPreviewProvider[] =
  TIKZ_PREVIEW_MODES
    .filter((mode): mode is TikzPreviewModeDescriptor & { id: Exclude<TikzPreviewModeId, 'visual'> } => mode.id !== 'visual')
    .map(mode => ({ ...mode, component: COMPONENTS[mode.id] }))

