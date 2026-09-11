/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Sidebar views
 * CVM-Role:        Model
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The table of the sidebar's views — one activity-bar icon
 *                  each, with the collapsible sections the view stacks — and
 *                  the table of those sections. The drawer, the activity bar
 *                  and the reveal path all read from here; nothing else
 *                  names a view or a section.
 *
 * END HEADER
 */

import { trans } from '@common/i18n-renderer'
import { SIDEBAR_SECTION_IDS, type SidebarSectionId, type SidebarViewId } from '@dts/common/sidebar-views'

/** One icon on an activity bar: what it shows and how it reads. */
export interface ActivityBarItem {
  id: string
  /** The tooltip and accessible name; a function because translations load at runtime. */
  label: () => string
  /** The Clarity icon shape. */
  icon: string
}

export interface SidebarViewDefinition extends ActivityBarItem {
  id: SidebarViewId
  /** The collapsible sections the view stacks, top to bottom. */
  sections: readonly SidebarSectionId[]
}

export interface SidebarSectionDefinition {
  id: SidebarSectionId
  label: () => string
}

export const SIDEBAR_VIEWS: readonly SidebarViewDefinition[] = [
  { id: 'explorer', label: () => trans('Explorer'), icon: 'file-group', sections: [ 'files', 'outline', 'book' ] },
  { id: 'search', label: () => trans('Search'), icon: 'search', sections: [] },
  { id: 'references', label: () => trans('References'), icon: 'library', sections: [ 'citations', 'relatedFiles' ] }
]

/**
 * The right edge's bar. The annotation review panel is the one view that
 * pane shows, so its bar carries one icon; the pane is open exactly while
 * that icon is pressed.
 */
export const PANEL_VIEW_ID = 'annotations'

export const PANEL_VIEWS: readonly ActivityBarItem[] = [
  { id: PANEL_VIEW_ID, label: () => trans('Annotations'), icon: 'chat-bubble' }
]

export const SIDEBAR_SECTIONS: readonly SidebarSectionDefinition[] = [
  { id: 'files', label: () => trans('Files') },
  { id: 'outline', label: () => trans('Outline') },
  { id: 'book', label: () => trans('Book') },
  { id: 'citations', label: () => trans('Citations') },
  { id: 'relatedFiles', label: () => trans('Related files') }
]

export function sidebarView (id: SidebarViewId): SidebarViewDefinition {
  const view = SIDEBAR_VIEWS.find(entry => entry.id === id)
  if (view === undefined) {
    throw new Error(`No sidebar view is named ${id}`)
  }
  return view
}

export function sidebarSection (id: SidebarSectionId): SidebarSectionDefinition {
  const section = SIDEBAR_SECTIONS.find(entry => entry.id === id)
  if (section === undefined) {
    throw new Error(`No sidebar section is named ${id}`)
  }
  return section
}

export type RevealFocus = 'none' | 'search-query' | 'project-filter'

/** Where a reveal lands: a view, optionally one of its sections, and the focus. */
export interface RevealTarget {
  view: SidebarViewId
  section?: SidebarSectionId
  focus: RevealFocus
}

export function expandedSectionIds (collapsed: readonly SidebarSectionId[]): SidebarSectionId[] {
  return SIDEBAR_SECTION_IDS.filter(id => !collapsed.includes(id))
}

export function collapsedSectionIds (expanded: readonly SidebarSectionId[]): SidebarSectionId[] {
  return SIDEBAR_SECTION_IDS.filter(id => !expanded.includes(id))
}
