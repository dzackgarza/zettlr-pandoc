/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Navigation shortcut defaults
 * CVM-Role:        Utility
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The single defaults registry behind the configurable
 *                  Back/Forward navigation shortcuts (issue #1 workstream 4,
 *                  review A8). The config template, the editor
 *                  configuration, and the default keymap all consume THIS
 *                  registry so the three surfaces cannot drift apart
 *                  (contract locked by
 *                  test/navigation-shortcut-config.spec.ts). This module is
 *                  shared between the main process and the renderer, so it
 *                  must stay dependency-free.
 *
 * END HEADER
 */

/**
 * The two configurable per-pane history navigation combos, in CodeMirror
 * keybinding syntax (e.g. 'Alt-ArrowLeft').
 */
export interface NavigationShortcutConfig {
  /** The combo bound to per-pane history Back */
  back: string
  /** The combo bound to per-pane history Forward */
  forward: string
}

/**
 * The contract-named defaults: configurable Alt-Left/Alt-Right.
 */
export const NAVIGATION_SHORTCUT_DEFAULTS: NavigationShortcutConfig = {
  back: 'Alt-ArrowLeft',
  forward: 'Alt-ArrowRight'
}
