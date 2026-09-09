/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Sidebar module identities
 * CVM-Role:        Types
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The identities of the main window's left-sidebar modules,
 *                  top to bottom. Declared here, outside the renderer,
 *                  because the config template persists the collapsed set
 *                  under these names.
 *
 * END HEADER
 */

export const SIDEBAR_MODULE_IDS = [ 'project', 'search', 'book', 'outline' ] as const

export type SidebarModuleId = typeof SIDEBAR_MODULE_IDS[number]

export function isSidebarModuleId (value: string): value is SidebarModuleId {
  return SIDEBAR_MODULE_IDS.some(id => id === value)
}
