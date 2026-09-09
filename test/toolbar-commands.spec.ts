/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Toolbar commands spec (PLAN-main-window-chrome-convergence, M4)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Every command the deleted toolbar row offered has an
 *                  application-menu item, so it reaches the user through the
 *                  menu, its shortcut and the launcher's rows. Checked
 *                  against the serialised menu captured from the running app
 *                  (test/fixtures/serialized-menu.linux.json) through the
 *                  launcher's own parser.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { readFileSync } from 'fs'
import path from 'path'
import { serializedMenuSchema, type SerializedMenuItem } from 'source/types/common/serialized-menu'

import { allMenuLeafRows } from 'source/win-main/launcher/launcher-rows'

const FIXTURE = path.join('test', 'fixtures', 'serialized-menu.linux.json')

/**
 * The toolbar's commands and the menu item that carries each one. A submenu
 * (Insert › Table) counts: the launcher drills into it.
 */
const TOOLBAR_COMMAND_MENU_ITEMS: Record<string, string> = {
  'toggle-navigation-sidebar': 'menu.toggle_navigation_sidebar',
  'root-open-workspaces': 'menu.open_workspace',
  'show-stats': 'menu.statistics',
  'show-tag-cloud': 'menu.tags',
  'open-preferences': 'menu.preferences',
  'new-file': 'menu.new_file',
  'previous-file': 'menu.previous_file',
  'next-file': 'menu.next_file',
  export: 'menu.export',
  pandocDivOrSpan: 'menu.insert_pandoc_div',
  markdownComment: 'menu.insert_comment',
  markdownLink: 'menu.insert_link',
  markdownImage: 'menu.insert_image',
  markdownMakeTaskList: 'menu.insert_task_list',
  'insert-table': 'menu.insert_table',
  insertFootnote: 'menu.insert_footnote',
  'toggle-sidebar': 'menu.toggle_annotation_panel',
  'open-updater': 'menu.update'
}

function submenuIds (items: readonly SerializedMenuItem[]): string[] {
  const ids: string[] = []
  for (const item of items) {
    if (item.type === 'submenu') {
      if (item.id !== undefined) {
        ids.push(item.id)
      }
      ids.push(...submenuIds(item.submenu))
    }
  }
  return ids
}

describe('the toolbar commands in the application menu', function () {
  const menu = serializedMenuSchema.parse(JSON.parse(readFileSync(FIXTURE, 'utf-8')))
  const leafIds = new Set(allMenuLeafRows(menu).rows.map(row => row.id))
  const groupIds = new Set(submenuIds(menu))

  for (const [ command, menuItemId ] of Object.entries(TOOLBAR_COMMAND_MENU_ITEMS)) {
    it(`carries the toolbar's ${command} as the menu item ${menuItemId}`, function () {
      assert.ok(
        leafIds.has(menuItemId) || groupIds.has(menuItemId),
        `${menuItemId} is neither an executable item nor a submenu of the captured menu`
      )
    })
  }
})
