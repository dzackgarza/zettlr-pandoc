/**
 * @ignore
 * BEGIN HEADER
 *
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Setup the test environment.
 *
 * END HEADER
 */

import { readFileSync } from "fs";
import { JSDOM } from "jsdom";
import Module from "module";
import path from "path";

// Webpack loads the icon SVGs as string literals (asset/source in
// webpack.rules.js); mirror that contract for specs importing modules that
// pull icon SVGs (e.g. the table editor's widget DOM).
Module._extensions[".svg"] = function (mod, filename) {
  mod.exports = readFileSync(filename, "utf8");
};
// Markdown documents are asset/source as well (e.g. the agent API's HELP.md).
Module._extensions[".md"] = function (mod, filename) {
  mod.exports = readFileSync(filename, "utf8");
};
// Stylesheets are injected by style-loader in the renderer; a spec under
// jsdom renders no CSS, so an imported stylesheet is an empty module.
Module._extensions[".css"] = function () {};

/**
 * Emulates a browser environment, which is required for some tests (especially if Vue is involved).
 * Code is essentially taken from https://github.com/enzymejs/enzyme/blob/master/docs/guides/jsdom.md.
 */
function mockBrowser() {
  // pretendToBeVisual gives the window jsdom's requestAnimationFrame and
  // cancelAnimationFrame, which CodeMirror's EditorView calls on its own window.
  const jsdom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost:3000/main_window/index.html",
    pretendToBeVisual: true,
  });
  const { window } = jsdom;

  // jsdom has no layout engine. It gives Element a zero rectangle and no
  // client rects (Element-impl.js in jsdom), but it gives Range neither
  // method, and CodeMirror measures text through Range. Range gets the same
  // zero geometry as Element.
  window.Range.prototype.getBoundingClientRect = function () {
    return new window.DOMRect();
  };
  window.Range.prototype.getClientRects = function () {
    return [];
  };

  // jsdom implements no ResizeObserver. Without layout no element ever
  // resizes, so an observer that never reports is the complete behaviour.
  window.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  function copyProps(src, target) {
    Object.defineProperties(target, {
      ...Object.getOwnPropertyDescriptors(src),
      ...Object.getOwnPropertyDescriptors(target),
    });
  }

  // The renderer utilities look for the path module on the window object, so
  // we copy it here in order for those tests not to fail.
  window.path = path;

  // Mock the window.config get() and set()
  window.config = {
    _data: new Map(),
    get(key) {
      if (key === undefined) return this._data;
      return this._data.get(key);
    },
    set(key, value) {
      this._data.set(key, value);
    },
  };

  // Mock the navigator.clipboard readText() and writeText()
  navigator.clipboard = {
    _data: "",
    readText() {
      return this._data;
    },
    writeText(text) {
      this._data = text;
    },
  };

  global.window = window;
  global.document = window.document;
  copyProps(window, global);
}

mockBrowser();
