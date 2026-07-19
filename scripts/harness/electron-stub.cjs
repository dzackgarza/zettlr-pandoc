// Headless electron shim: lets the app's main-process code (which imports
// 'electron') run under `node --import tsx` without opening the GUI. tsx emits
// CJS require(), so the interception happens at Module._load.
//
// Preload it with:  node --require ./scripts/harness/electron-stub.cjs ...
const Module = require('module')
const os = require('os')
const path = require('path')
const orig = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    const userData = path.join(os.homedir(), '.config', 'Zettlr-Pandoc')
    return {
      app: {
        getPath: (key) => key === 'userData' ? userData : '/tmp',
        isPackaged: false,
        getName: () => 'Zettlr-Pandoc'
      },
      ipcMain: { handle () {}, on () {}, removeHandler () {} },
      dialog: { showErrorBox () {} },
      shell: { openPath: async () => '' },
      BrowserWindow: class {}
    }
  }
  return orig.call(this, request, ...rest)
}
