/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Sidebar view identities
 * CVM-Role:        Types
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The identities of the main window's sidebar views (one
 *                  per activity-bar icon) and of the collapsible sections
 *                  inside them. Declared here, outside the renderer,
 *                  because the config template persists the shown view and
 *                  the collapsed sections under these names.
 *
 * END HEADER
 */

export const SIDEBAR_VIEW_IDS = [ 'explorer', 'search', 'references' ] as const

export type SidebarViewId = typeof SIDEBAR_VIEW_IDS[number]

export function isSidebarViewId (value: string): value is SidebarViewId {
  return SIDEBAR_VIEW_IDS.some(id => id === value)
}

export const SIDEBAR_SECTION_IDS = [ 'files', 'outline', 'book', 'citations', 'relatedFiles' ] as const

export type SidebarSectionId = typeof SIDEBAR_SECTION_IDS[number]

export function isSidebarSectionId (value: string): value is SidebarSectionId {
  return SIDEBAR_SECTION_IDS.some(id => id === value)
}
