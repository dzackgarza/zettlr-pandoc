/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Launcher rows
 * CVM-Role:        Model
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The pure half of the command launcher's list: how the
 *                  serialised application menu becomes rows, how a query
 *                  ranks them, and the four dynamic groups whose rows come
 *                  from renderer stores and providers. No framework, no IPC.
 *
 * END HEADER
 */

// NOTE: fzf is ESM-only; this must remain a real ESM import (see
// util/reference-search.ts and the webpack alias that serves the ES build).
import { Fzf } from 'fzf'
import type { SerializedMenuItem, SerializedSubmenu } from '@dts/common/serialized-menu'
import type { ValidPandocProfile } from '@providers/assets'

/** A group's address from the root: one key per nesting level. */
export type GroupPath = readonly string[]

export type DynamicGroupId = 'go-to-file' | 'go-to-heading' | 'search-references' | 'export'

export interface MenuLeafRow {
  kind: 'menu-leaf'
  /** The application-menu item id: the command identity. */
  id: string
  label: string
  accelerator?: string
  enabled: boolean
  checked?: boolean
  /** The labels of the groups above this leaf, root first. */
  breadcrumb: readonly string[]
}

export interface MenuGroupRow {
  kind: 'menu-group'
  path: GroupPath
  label: string
  enabled: boolean
  breadcrumb: readonly string[]
}

export interface DynamicGroupRow {
  kind: 'dynamic-group'
  id: DynamicGroupId
  label: string
}

export interface FileRow {
  kind: 'file'
  path: string
  label: string
  /** The workspace-relative directory of the file. */
  breadcrumb: readonly string[]
}

export interface HeadingRow {
  kind: 'heading'
  line: number
  level: number
  label: string
}

/** One export profile the assets provider can run on the active document. */
export interface ExportProfileRow {
  kind: 'export-profile'
  profile: ValidPandocProfile
  label: string
}

/** One custom export command from the export settings. */
export interface ExportCommandRow {
  kind: 'export-command'
  displayName: string
  command: string
  label: string
}

export type LauncherRow = MenuLeafRow | MenuGroupRow | DynamicGroupRow | FileRow | HeadingRow | ExportProfileRow | ExportCommandRow

/** What the launcher asks the window to export the active document with. */
export type ExportRequest =
  | { kind: 'profile', profile: ValidPandocProfile }
  | { kind: 'command', displayName: string, command: string }


/**
 * A group's key in a path: its id, or a label-derived key when the template
 * gave the submenu no id ("New file…" is one).
 */
export function groupKey (item: SerializedSubmenu): string {
  return item.id === undefined ? `label:${item.label}` : item.id
}

/** A row's identity, stable across re-renders: what the list keys and selects by. */
export function rowKey (row: LauncherRow): string {
  switch (row.kind) {
    case 'menu-leaf':
      return `menu-leaf:${row.id}`
    case 'menu-group':
      return `menu-group:${row.path.join('/')}`
    case 'dynamic-group':
      return `dynamic-group:${row.id}`
    case 'file':
      return `file:${row.path}`
    case 'heading':
      return `heading:${row.line}`
    case 'export-profile':
      return `export-profile:${row.profile.name}`
    case 'export-command':
      return `export-command:${row.command}`
  }
}

/** Resolves a group path against the menu; undefined when no such group. */
export function resolveGroup (menu: readonly SerializedMenuItem[], path: GroupPath): SerializedSubmenu | undefined {
  let items: readonly SerializedMenuItem[] = menu
  let group: SerializedSubmenu | undefined
  for (const key of path) {
    group = items.find((item): item is SerializedSubmenu => item.type === 'submenu' && groupKey(item) === key)
    if (group === undefined) {
      return undefined
    }
    items = group.submenu
  }
  return group
}

function itemsToRows (
  items: readonly SerializedMenuItem[],
  path: GroupPath,
  breadcrumb: readonly string[]
): Array<MenuLeafRow | MenuGroupRow> {
  const rows: Array<MenuLeafRow | MenuGroupRow> = []
  for (const item of items) {
    if (item.type === 'separator') {
      continue
    }
    if (item.type === 'submenu') {
      rows.push({
        kind: 'menu-group',
        path: [ ...path, groupKey(item) ],
        label: item.label,
        enabled: item.enabled,
        breadcrumb
      })
      continue
    }
    if (item.id === undefined) {
      throw new Error(
        `The application menu carries an executable item the launcher cannot address: ${item.label} ` +
        `under ${[ ...path ].join(' › ')}. click-menu-item needs the id, so the item would be listed and ` +
        'do nothing, or be left out of the list without saying so. Give it an id where the menu is built ' +
        '(source/app/service-providers/menu/menu.linux.ts and its platform siblings).'
      )
    }
    rows.push({
      kind: 'menu-leaf',
      id: item.id,
      label: item.label,
      accelerator: item.accelerator,
      enabled: item.enabled,
      checked: item.type === 'normal' ? undefined : item.checked,
      breadcrumb
    })
  }
  return rows
}

/**
 * The rows of one menu group (the root when the path is empty): its groups
 * and leaves in menu order, separators dropped.
 */
export function menuGroupRows (
  menu: readonly SerializedMenuItem[],
  path: GroupPath
): Array<MenuLeafRow | MenuGroupRow> {
  if (path.length === 0) {
    return itemsToRows(menu, [], [])
  }
  const group = resolveGroup(menu, path)
  if (group === undefined) {
    throw new Error(
      `The launcher is showing a menu group that the menu does not carry: ${[ ...path ].join(' › ')}. ` +
      `The menu's top level is ${menu.map(item => item.type === 'submenu' ? groupKey(item) : item.type).join(', ')}. ` +
      'A view holds a path taken from a row of this same menu, so this is a defect in the navigation state ' +
      '(source/win-main/launcher/launcher-state.ts), not a group with nothing in it.'
    )
  }
  return itemsToRows(group.submenu, path, breadcrumbOf(menu, path))
}

/** The labels along a group path, root first. */
export function breadcrumbOf (menu: readonly SerializedMenuItem[], path: GroupPath): string[] {
  const labels: string[] = []
  let items: readonly SerializedMenuItem[] = menu
  for (const key of path) {
    const group = items.find((item): item is SerializedSubmenu => item.type === 'submenu' && groupKey(item) === key)
    if (group === undefined) {
      return labels
    }
    labels.push(group.label)
    items = group.submenu
  }
  return labels
}

/** Every leaf of the menu with its breadcrumb, in menu order. */
export function allMenuLeafRows (menu: readonly SerializedMenuItem[]): MenuLeafRow[] {
  const rows: MenuLeafRow[] = []
  const walk = (items: readonly SerializedMenuItem[], path: GroupPath, breadcrumb: readonly string[]): void => {
    for (const row of itemsToRows(items, path, breadcrumb)) {
      if (row.kind === 'menu-leaf') {
        rows.push(row)
        continue
      }
      const group = resolveGroup(menu, row.path)
      if (group === undefined) {
        throw new Error(
          `A submenu row of this menu does not resolve back to its submenu: ${[ ...row.path ].join(' › ')}. ` +
          'The row was built from the menu being walked, so the group key (groupKey in this file) does not ' +
          'address it uniquely; fix the key rather than leaving that submenu out of the flattened list.'
        )
      }
      walk(group.submenu, row.path, [ ...breadcrumb, group.label ])
    }
  }
  walk(menu, [], [])
  return rows
}

/**
 * Ranks rows against a query with fzf over the row label: descending score,
 * ties in the incoming order. The empty query keeps every row in order.
 */
export function rankRows (rows: readonly LauncherRow[], query: string): LauncherRow[] {
  if (query === '') {
    return [...rows]
  }
  const fzf = new Fzf([...rows], { selector: (row: LauncherRow) => row.label })
  return fzf.find(query).map(result => result.item)
}
