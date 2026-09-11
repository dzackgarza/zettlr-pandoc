/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Command launcher model specs (PLAN-command-launcher, M3)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks the pure half of the launcher against the
 *                  application menu the menu provider serialised from the
 *                  running app on Linux (test/fixtures/serialized-menu.linux.json):
 *                  the boundary parse, the rows a group yields, the
 *                  breadcrumbs of flattened leaves, fzf ranking, and the
 *                  navigation state machine.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { readFileSync } from 'fs'
import path from 'path'
import { serializedMenuSchema } from 'source/types/common/serialized-menu'
import {
  allMenuLeafRows,
  menuGroupRows,
  rankRows,
  resolveGroup,
  rowKey
} from 'source/win-main/launcher/launcher-rows'
import {
  CLOSED_LAUNCHER,
  drillInto,
  openLauncherAt,
  popLevel,
  setQuery
} from 'source/win-main/launcher/launcher-state'

const FIXTURE = path.join('test', 'fixtures', 'serialized-menu.linux.json')

/** The raw payload, parsed at the boundary the way the launcher parses it. */
function loadMenu () {
  const raw: unknown = JSON.parse(readFileSync(FIXTURE, 'utf-8'))
  return serializedMenuSchema.parse(raw)
}

/** Independent oracle: every executable item of the raw payload, counted without the parser. */
function countRawLeaves (node: unknown): number {
  if (Array.isArray(node)) {
    return node.reduce<number>((sum, child) => sum + countRawLeaves(child), 0)
  }
  if (typeof node !== 'object' || node === null || !('type' in node)) {
    return 0
  }
  const item = node as { type: string, id?: string, submenu?: unknown }
  if (item.type === 'submenu') {
    return countRawLeaves(item.submenu)
  }
  if ((item.type === 'normal' || item.type === 'checkbox' || item.type === 'radio') && typeof item.id === 'string' && item.id !== '') {
    return 1
  }
  return 0
}

describe('command launcher: serialised menu boundary', function () {
  it('parses the menu the provider serialised from the running app', function () {
    const menu = loadMenu()
    assert.deepEqual(
      menu.map(item => item.type === 'submenu' ? item.id : item.type),
      [ 'file-menu', 'edit-menu', 'insert-menu', 'format-menu', 'view-menu', 'window-menu', 'help-menu' ],
      'the top level is the seven application menus, each a submenu with its id'
    )
  })

  it('rejects an item whose type the provider never emits', function () {
    const result = serializedMenuSchema.safeParse([{ type: 'weird', id: 'x', label: 'X', enabled: true }])
    assert.equal(result.success, false)
  })
})

describe('command launcher: rows', function () {
  it('lists a group as its groups and leaves in menu order, separators dropped', function () {
    const menu = loadMenu()
    const { rows, report } = menuGroupRows(menu, [ 'file-menu' ])
    assert.equal(report.droppedLeavesWithoutId, 0, 'every File leaf carries an id')
    assert.equal(rows[0].kind, 'menu-group')
    assert.deepEqual(rows[0].kind === 'menu-group' ? rows[0].path : [], [ 'file-menu', 'label:New file…' ], 'the id-less New file… submenu is addressed by its label')
    const open = rows.find(row => row.kind === 'menu-leaf' && row.id === 'menu.open')
    assert.ok(open !== undefined && open.kind === 'menu-leaf')
    assert.equal(open.label, 'Open file…')
    assert.equal(open.accelerator, 'Ctrl+O')
    assert.equal(open.enabled, true)
    assert.deepEqual(open.breadcrumb, [ 'File' ])
    assert.ok(rows.every(row => row.kind !== 'menu-leaf' || row.id !== ''), 'no separator survives as a row')
  })

  it('resolves an id-less group through its label key', function () {
    const menu = loadMenu()
    const group = resolveGroup(menu, [ 'file-menu', 'label:New file…' ])
    assert.ok(group !== undefined)
    assert.deepEqual(
      group.submenu.filter(item => item.type === 'normal').map(item => item.type === 'normal' ? item.id : undefined),
      [ 'menu.new_file', 'menu.new_tex_file', 'menu.new_yaml_file', 'menu.new_json_file' ]
    )
  })

  it('flattens every executable leaf once, with its breadcrumb', function () {
    const menu = loadMenu()
    const raw: unknown = JSON.parse(readFileSync(FIXTURE, 'utf-8'))
    const { rows, report } = allMenuLeafRows(menu)
    assert.equal(rows.length, countRawLeaves(raw), 'one row per executable item of the raw payload')
    assert.equal(report.droppedLeavesWithoutId, 0)
    const darkMode = rows.find(row => row.id === 'menu.toggle_theme')
    assert.ok(darkMode !== undefined)
    assert.deepEqual(darkMode.breadcrumb, [ 'View' ])
    assert.equal(typeof darkMode.checked, 'boolean', 'a checkbox leaf carries its checked state')
    const newTex = rows.find(row => row.id === 'menu.new_tex_file')
    assert.ok(newTex !== undefined)
    assert.deepEqual(newTex.breadcrumb, [ 'File', 'New file…' ])
  })

  it('ranks leaves by fzf score over the label and keeps menu order on the empty query', function () {
    const menu = loadMenu()
    const { rows } = allMenuLeafRows(menu)
    assert.deepEqual(rankRows(rows, '').map(rowKey), rows.map(rowKey))
    const zoom = rankRows(rows, 'zoom').map(row => row.label)
    assert.deepEqual(new Set(zoom), new Set([ 'Reset zoom', 'Zoom in', 'Zoom out' ]))
    const darkMode = rankRows(rows, 'darkmo')[0]
    assert.ok(darkMode !== undefined && darkMode.kind === 'menu-leaf' && darkMode.id === 'menu.toggle_theme', 'a scattered fuzzy query still finds Dark mode')
    assert.equal(rankRows(rows, 'qzxv').length, 0, 'a query nothing matches yields no rows')
  })
})

describe('command launcher: navigation state', function () {
  it('drills down with an empty query, pops back to the parent, and closes above the root', function () {
    const root = openLauncherAt({ kind: 'root' })
    assert.deepEqual(root, { open: true, view: { kind: 'root' }, query: '', stack: [] })

    const typed = setQuery(root, 'ins')
    const insert = drillInto(typed, { kind: 'menu-group', path: [ 'insert-menu' ] })
    assert.deepEqual(insert, {
      open: true,
      view: { kind: 'menu-group', path: [ 'insert-menu' ] },
      query: '',
      stack: [{ kind: 'root' }]
    })

    const table = drillInto(setQuery(insert, 'tab'), { kind: 'menu-group', path: [ 'insert-menu', 'menu.insert_table' ] })
    assert.equal(table.open && table.stack.length, 2)

    const back = popLevel(table)
    assert.deepEqual(back, insert, 'popping restores the parent view with an empty query')
    assert.deepEqual(popLevel(back), root)
    assert.deepEqual(popLevel(root), CLOSED_LAUNCHER, 'popping at the root closes the launcher')
    assert.deepEqual(popLevel(CLOSED_LAUNCHER), CLOSED_LAUNCHER)
  })

  it('opens the references view directly with the relayed request', function () {
    const keyed = openLauncherAt({ kind: 'references', request: { key: 'sec-forms' } })
    assert.deepEqual(keyed, { open: true, view: { kind: 'references', request: { key: 'sec-forms' } }, query: '', stack: [] })
    assert.deepEqual(popLevel(keyed), CLOSED_LAUNCHER)
  })
})

describe('command launcher: a menu the launcher cannot present in full', function () {
  it('fails on a group path that names no submenu, rather than presenting the group as empty', function () {
    const menu = loadMenu()
    assert.throws(
      () => menuGroupRows(menu, [ 'file-menu', 'label:No such group' ]),
      Error,
      'an unresolvable path is a defect in the navigation state, not a group with no items'
    )
  })

  it('fails on an executable item the provider serialised without an id, rather than dropping it from the list', function () {
    const menu = loadMenu()
    const withUnaddressableLeaf: typeof menu = [
      ...menu,
      {
        type: 'submenu',
        id: 'test-menu',
        label: 'Test',
        enabled: true,
        submenu: [{ type: 'normal', label: 'Unreachable', enabled: true }]
      }
    ]
    assert.throws(
      () => menuGroupRows(withUnaddressableLeaf, [ 'test-menu' ]),
      Error,
      'a leaf with no id can never be clicked, so the launcher must say so instead of listing one command fewer'
    )
    assert.throws(() => allMenuLeafRows(withUnaddressableLeaf), Error)
  })
})
