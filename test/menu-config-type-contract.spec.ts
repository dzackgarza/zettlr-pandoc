/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Menu configuration type contract tests
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Compile-time proof that the application menu can write
 *                  only its supported configuration key/value pairs.
 *
 * END HEADER
 */

import assert from 'assert'
import 'mocha'
import type { MenuConfig } from 'source/app/service-providers/menu/menu-dependencies'

type MenuSetArguments = Parameters<MenuConfig['set']>

type DarkModeBooleanAccepted =
  ['darkMode', boolean] extends MenuSetArguments ? true : false
type FileMetaBooleanAccepted =
  ['fileMeta', boolean] extends MenuSetArguments ? true : false
type FontSizeNumberAccepted =
  ['editor.fontSize', number] extends MenuSetArguments ? true : false
type DarkModeNumberRejected =
  ['darkMode', number] extends MenuSetArguments ? false : true
type FontSizeBooleanRejected =
  ['editor.fontSize', boolean] extends MenuSetArguments ? false : true
type UnsupportedKeyRejected =
  ['debug', boolean] extends MenuSetArguments ? false : true

const darkModeBooleanAccepted: DarkModeBooleanAccepted = true
const fileMetaBooleanAccepted: FileMetaBooleanAccepted = true
const fontSizeNumberAccepted: FontSizeNumberAccepted = true
const darkModeNumberRejected: DarkModeNumberRejected = true
const fontSizeBooleanRejected: FontSizeBooleanRejected = true
const unsupportedKeyRejected: UnsupportedKeyRejected = true

describe('menu configuration type contract', function () {
  it('couples each supported key to its value type', function () {
    assert.strictEqual(darkModeBooleanAccepted, true)
    assert.strictEqual(fileMetaBooleanAccepted, true)
    assert.strictEqual(fontSizeNumberAccepted, true)
    assert.strictEqual(darkModeNumberRejected, true)
    assert.strictEqual(fontSizeBooleanRejected, true)
    assert.strictEqual(unsupportedKeyRejected, true)
  })
})
