/**
 * Mounts the REAL toolbar Back/Forward navigation controls for isolated
 * visual capture (issue #1 Phase 5; ledger C4). No fakes: the page mounts
 * the production WindowToolbar with the production ButtonControl pair,
 * configured with exactly the control objects App.vue builds for
 * 'previous-file' and 'next-file' — icon 'arrow' with left/right direction
 * and `disabled` driven by the session history state (canGoBack /
 * canGoForward). The Clarity icon set is registered through the production
 * loader (window-register/load-icons), so the arrow glyphs are the real
 * cds-icon web components.
 *
 * Scenes (body.dataset.scene):
 * - 'enabled':  both directions have history (canGoBack and canGoForward)
 * - 'disabled': both at a history boundary (the App.vue initial state)
 */

import { createApp, h, nextTick } from 'vue'
import WindowToolbar, { type ToolbarControl } from 'source/common/vue/window/WindowToolbar.vue'
import loadIcons from 'source/common/modules/window-register/load-icons'
import { trans } from 'source/common/i18n-renderer'

declare global {
  interface Window {
    captureReady: Promise<void>
  }
}

/**
 * The exact Back/Forward control objects App.vue configures (issue #1
 * Phase 5): enabled exactly when the focused pane's session history has an
 * entry in that direction.
 */
function navigationControls (canGoBack: boolean, canGoForward: boolean): ToolbarControl[] {
  return [
    {
      type: 'button',
      id: 'previous-file',
      title: trans('Navigate back'),
      icon: 'arrow',
      direction: 'left',
      disabled: !canGoBack
    },
    {
      type: 'button',
      id: 'next-file',
      title: trans('Navigate forward'),
      icon: 'arrow',
      direction: 'right',
      disabled: !canGoForward
    }
  ]
}

async function mount (): Promise<void> {
  await loadIcons()

  const scene = document.body.dataset.scene ?? 'enabled'
  const enabled = scene === 'enabled'
  const controls = navigationControls(enabled, enabled)

  createApp({
    render: () => h(WindowToolbar, { controls })
  }).mount('#app')

  await nextTick()
  await document.fonts.ready
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

window.captureReady = mount()
