/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Menu shortcut dispatch specs
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Electron hands a menu item's click the window that held
 *                  the focus, and passes nothing when no window did. A menu
 *                  item the user picked has to reach a window or say that it
 *                  could not: an Insert or Format item that returns quietly
 *                  leaves the document unchanged with nothing to read.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { sendShortcut } from 'source/app/service-providers/menu/menu-editing'

describe('menu shortcut dispatch', function () {
  it('fails when the picked item has no window to act on, rather than returning quietly', function () {
    assert.throws(() => sendShortcut(undefined, 'insert-table'), Error, 'Electron passes undefined when no window held the focus')
    assert.throws(() => sendShortcut(null, 'insert-table'), Error, 'the menu provider passes null when it resolved no window either')
  })

  it('fails when the window it was given cannot receive the shortcut', function () {
    const windowWithoutContents = { id: 7 } as unknown as Parameters<typeof sendShortcut>[0]
    assert.throws(
      () => sendShortcut(windowWithoutContents, 'insert-table'),
      Error,
      'a BaseWindow carries no webContents, so the shortcut has nowhere to go'
    )
  })
})
