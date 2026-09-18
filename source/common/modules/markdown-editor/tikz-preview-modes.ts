/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikZ preview-mode capability model
 * CVM-Role:        Domain
 * License:         GNU GPL v3
 *
 * Description:     Declares the preview/editor modes which may host one active
 *                  TikZ source block. Availability is source-semantic rather
 *                  than a view concern: tikzcd may use Quiver, while the
 *                  direct-manipulation canvas is deliberately restricted to
 *                  an authored tikzpicture environment. The renderer shell
 *                  consumes these descriptors instead of hard-coding mode
 *                  branches.
 *
 * END HEADER
 */

import type { TikzLivePreviewTarget } from './tikz-live-preview'
import { rawTikzEnvironment } from './tikz-block'

export type TikzPreviewModeId = 'tikz'|'quiver'|'visual'

export interface TikzPreviewModeDescriptor {
  id: TikzPreviewModeId
  label: string
  refreshable: boolean
  supports: (target: TikzLivePreviewTarget) => boolean
  unavailableTitle: (target: TikzLivePreviewTarget) => string
}

function supportsVisualEditor (target: TikzLivePreviewTarget): boolean {
  return target.language === 'tikz' && rawTikzEnvironment(target.source) === 'tikzpicture'
}

export const TIKZ_PREVIEW_MODES: readonly TikzPreviewModeDescriptor[] = [
  {
    id: 'tikz',
    label: 'TikZ',
    refreshable: true,
    supports: () => true,
    unavailableTitle: () => ''
  },
  {
    id: 'quiver',
    label: 'Quiver',
    refreshable: false,
    supports: target => target.language === 'tikzcd',
    unavailableTitle: () => 'Quiver is available only for tikzcd diagrams'
  },
  {
    id: 'visual',
    label: 'Visual',
    refreshable: false,
    supports: supportsVisualEditor,
    unavailableTitle: target => target.language === 'tikzcd'
      ? 'The visual canvas is for tikzpicture diagrams; tikzcd uses Quiver'
      : 'The visual canvas requires an authored tikzpicture environment'
  }
]

export function defaultTikzPreviewMode (target: TikzLivePreviewTarget): TikzPreviewModeId {
  return target.language === 'tikzcd' ? 'quiver' : 'tikz'
}

export function resolvedTikzPreviewMode (
  requested: TikzPreviewModeId,
  target: TikzLivePreviewTarget
): TikzPreviewModeId {
  const descriptor = TIKZ_PREVIEW_MODES.find(mode => mode.id === requested)
  return descriptor?.supports(target) === true ? requested : defaultTikzPreviewMode(target)
}

