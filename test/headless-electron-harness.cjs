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

const Module = require("module");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Per-process, because this path is a real app-data directory: the harness
// writes documents.yaml here and the providers read it back on boot. A fixed
// path made every concurrent mocha process share one file, so one run booted
// against another's half-written state and tore with "Implicit keys need to be
// on a single line" — a failure that belongs to neither run and reproduces
// from leftover state alone. The pid keys it to the process that owns it.
const userData = fs.mkdtempSync(
  path.join(os.tmpdir(), `zettlr-pandoc-headless-test-${process.pid}-`),
);
fs.mkdirSync(path.join(userData, "logs"), { recursive: true });
fs.mkdirSync(path.join(userData, "lang"), { recursive: true });

/**
 * Records every ipcMain.handle registration made by main-process modules
 * loaded under this harness, keyed by channel. The recorded listener is the
 * REAL registered function — specs invoke it directly to exercise the real
 * provider delegation path. The stub records registrations only; it never
 * fabricates handler behavior.
 *
 * @type {Map<string, Function>}
 */
const ipcMainHandlers = new Map();
const sentMessages = new WeakMap();

class HeadlessBrowserWindow {
  constructor() {
    const messages = [];
    sentMessages.set(this, messages);
    this.webContents = {
      send(...args) {
        messages.push(args);
      },
    };
  }

  // Real Electron semantics for a process with no open windows: the list is
  // empty, so broadcastIPCMessage() sends to nobody.
  static getAllWindows() {
    return [];
  }
}

class HeadlessMenuItem {
  constructor(options) {
    Object.assign(this, options);
  }
}

/**
 * Returns the messages sent through a headless BrowserWindow instance.
 *
 * @param {HeadlessBrowserWindow} window
 * @returns {unknown[][]}
 */
function sentMessagesFor(window) {
  const messages = sentMessages.get(window);
  if (messages === undefined) {
    throw new Error("Window was not created by the headless Electron harness");
  }
  return messages;
}

const orig = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") {
    return {
      app: {
        getPath: (key) => (key === "userData" ? userData : os.tmpdir()),
        isPackaged: false,
        getName: () => "Zettlr-Pandoc",
        getVersion: () => "0.0.0-headless-test",
        getLocale: () => "en-US",
        on() {},
        whenReady: async () => {},
      },
      ipcMain: {
        handle(channel, listener) {
          ipcMainHandlers.set(channel, listener);
        },
        on() {},
        removeHandler(channel) {
          ipcMainHandlers.delete(channel);
        },
      },
      dialog: { showErrorBox() {} },
      shell: { openPath: async () => "" },
      nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
      Notification: class {
        show() {}
      },
      BrowserWindow: HeadlessBrowserWindow,
      MenuItem: HeadlessMenuItem,
    };
  }
  return orig.call(this, request, ...rest);
};

// userData is exported because it is now per-process: a spec that needs the
// directory must ask the harness that created it rather than recomputing the
// path, which is what coupled the two to a fixed location in the first place.
module.exports = { ipcMainHandlers, sentMessagesFor, userData };
