/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Launcher state
 * CVM-Role:        Model
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The command launcher's navigation as a typed state
 *                  machine: closed, or open on one view with a query and the
 *                  stack of views it drilled down from. Pure transitions;
 *                  the component owns the effects.
 *
 * END HEADER
 */

import type { ReferenceSearchRequest } from '@common/modules/markdown-editor/plugins/reference-search-effect'
import type { GroupPath } from './launcher-rows'

export type LauncherView =
  | { kind: 'root' }
  | { kind: 'menu-group', path: GroupPath }
  | { kind: 'dynamic-group', id: 'go-to-file' | 'go-to-heading' | 'export' }
  | { kind: 'references', request: ReferenceSearchRequest }

export type LauncherState =
  | { open: false }
  | { open: true, view: LauncherView, query: string, stack: readonly LauncherView[] }

export const CLOSED_LAUNCHER: LauncherState = { open: false }

/** Opens the launcher on a view with an empty query and nothing to go back to. */
export function openLauncherAt (view: LauncherView): LauncherState {
  return { open: true, view, query: '', stack: [] }
}

/** Drills from the current view into a deeper one; Backspace on an empty query comes back. */
export function drillInto (state: LauncherState, view: LauncherView): LauncherState {
  if (!state.open) {
    return openLauncherAt(view)
  }
  return { open: true, view, query: '', stack: [ ...state.stack, state.view ] }
}

/** One level up; at the top there is nothing above, so the launcher closes. */
export function popLevel (state: LauncherState): LauncherState {
  if (!state.open) {
    return state
  }
  const parent = state.stack[state.stack.length - 1]
  if (parent === undefined) {
    return CLOSED_LAUNCHER
  }
  return { open: true, view: parent, query: '', stack: state.stack.slice(0, -1) }
}

export function setQuery (state: LauncherState, query: string): LauncherState {
  if (!state.open) {
    return state
  }
  return { ...state, query }
}

export function closeLauncher (): LauncherState {
  return CLOSED_LAUNCHER
}
