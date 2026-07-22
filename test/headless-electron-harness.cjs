/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Headless electron harness for FSAL specs
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Lets specs import real main-process FSAL modules (which
 *                  transitively import 'electron' through the app service
 *                  container) under plain Node. Modeled on the repository's
 *                  own scripts/harness/electron-stub.cjs (used by
 *                  `just export-headless`), extended with the module-scope
 *                  surface the provider graph touches at import time
 *                  (nativeImage.createFromPath in show-notification.ts,
 *                  app.getVersion/getLocale). This shim only makes the module
 *                  graph loadable; no behavior under proof touches it — the
 *                  parser under test never calls into Electron because the
 *                  app service container is never booted.
 *
 * END HEADER
 */

const Module = require('module')
const os = require('os')
const path = require('path')
const orig = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    const userData = path.join(os.tmpdir(), 'zettlr-pandoc-headless-test')
    return {
      app: {
        getPath: (key) => key === 'userData' ? userData : os.tmpdir(),
        isPackaged: false,
        getName: () => 'Zettlr-Pandoc',
        getVersion: () => '0.0.0-headless-test',
        getLocale: () => 'en-US',
        on () {},
        whenReady: async () => {}
      },
      ipcMain: { handle () {}, on () {}, removeHandler () {} },
      dialog: { showErrorBox () {} },
      shell: { openPath: async () => '' },
      nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
      Notification: class { show () {} },
      BrowserWindow: class {}
    }
  }
  return orig.call(this, request, ...rest)
}
