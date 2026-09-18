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
import TikzVisualPreview from './TikzVisualPreview.vue'

export interface TikzPreviewProvider extends TikzPreviewModeDescriptor {
  component: Component
}

const COMPONENTS: Record<TikzPreviewModeId, Component> = {
  tikz: TikzCompilerPreview,
  quiver: TikzQuiverPreview,
  visual: TikzVisualPreview
}

export const TIKZ_PREVIEW_PROVIDERS: readonly TikzPreviewProvider[] =
  TIKZ_PREVIEW_MODES.map(mode => ({ ...mode, component: COMPONENTS[mode.id] }))
