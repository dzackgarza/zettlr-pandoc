/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Sidebar module table
 * CVM-Role:        Model
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The one array naming the left sidebar's modules, top to
 *                  bottom. A module is an entry here and nothing else: the
 *                  sidebar renders every entry through SidebarModule.vue.
 *
 * END HEADER
 */

import { trans } from '@common/i18n-renderer'
import type { SidebarModuleId } from '@dts/common/sidebar-modules'

export interface SidebarModuleDefinition {
  id: SidebarModuleId
  /** The header label; a function because translations load at runtime. */
  label: () => string
}

export const SIDEBAR_MODULES: readonly SidebarModuleDefinition[] = [
  { id: 'project', label: () => trans('Project') }
]

/**
 * The expanded module ids for a persisted collapsed set: every module that is
 * not collapsed.
 */
export function expandedModuleIds (collapsed: readonly SidebarModuleId[]): SidebarModuleId[] {
  return SIDEBAR_MODULES
    .map(module => module.id)
    .filter(id => !collapsed.includes(id))
}

/**
 * The collapsed set to persist when the accordion reports its expanded ids.
 */
export function collapsedModuleIds (expanded: readonly SidebarModuleId[]): SidebarModuleId[] {
  return SIDEBAR_MODULES
    .map(module => module.id)
    .filter(id => !expanded.includes(id))
}
