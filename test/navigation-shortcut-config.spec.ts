/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Configurable navigation shortcut specs (issue #1, review A8 red)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks the minimal configuration surface behind the
 *                  "configurable Alt-Left/Alt-Right defaults" contract
 *                  (issue #1 workstream 4): one shared defaults registry
 *                  feeds the config template, the editor configuration, and
 *                  the default keymap, and the keymap consumes the CONFIGURED
 *                  combos at extension-build time. The dispatch proof drives
 *                  a real EditorView through CodeMirror's own scope handler
 *                  with real KeyboardEvents; the observation point is the
 *                  window.ipc preload seam the navigation commands invoke
 *                  ('documents-provider' navigate-back/navigate-forward),
 *                  provisioned by the spec exactly as the production preload
 *                  provides it.
 *
 * END HEADER
 */

import { EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { strict as assert } from "assert";
import {
  defaultKeymap,
  navigationKeybindings,
} from "source/common/modules/markdown-editor/keymaps/default";
import { editorMetadataFacet } from "source/common/modules/markdown-editor/plugins/editor-metadata";
import { getDefaultConfig } from "source/common/modules/markdown-editor/util/configuration";
import {
  navigateHistoryBack,
  navigateHistoryForward,
} from "source/common/modules/markdown-editor/util/reference-navigation";
import {
  NAVIGATION_SHORTCUT_DEFAULTS,
  type NavigationShortcutConfig,
} from "source/common/util/navigation-shortcuts";

/** One recorded renderer->main request at the window.ipc preload seam. */
interface RecordedInvoke {
  channel: string;
  message: { command: string; payload?: unknown };
}

/** The jsdom polyfills CodeMirror views need (per the editor specs). */
function polyfillJsdomForCodeMirror(): void {
  const w = globalThis as any;
  if (typeof w.requestAnimationFrame !== "function") {
    w.requestAnimationFrame = (callback: (time: number) => void) =>
      setTimeout(() => callback(Date.now()), 0);
    w.cancelAnimationFrame = (id: any) => clearTimeout(id);
  }
  if (typeof w.window === "object" && typeof w.window.requestAnimationFrame !== "function") {
    w.window.requestAnimationFrame = w.requestAnimationFrame;
    w.window.cancelAnimationFrame = w.cancelAnimationFrame;
  }
  if (typeof w.ResizeObserver !== "function") {
    w.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    if (typeof w.window === "object") {
      w.window.ResizeObserver = w.ResizeObserver;
    }
  }
  if (typeof w.Range?.prototype.getClientRects !== "function") {
    w.Range.prototype.getClientRects = () => [];
    w.Range.prototype.getBoundingClientRect = () => ({
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
  }
}

describe("Configurable navigation shortcuts (review A8)", function () {
  it("registers Alt-ArrowLeft/Alt-ArrowRight as the shared defaults", function () {
    assert.deepStrictEqual(NAVIGATION_SHORTCUT_DEFAULTS, {
      back: "Alt-ArrowLeft",
      forward: "Alt-ArrowRight",
    });
  });

  it("plumbs the defaults through the editor configuration", function () {
    assert.deepStrictEqual(
      getDefaultConfig().navigationShortcuts,
      NAVIGATION_SHORTCUT_DEFAULTS,
      "the editor configuration must carry the navigation shortcut combos so the host can supply configured values",
    );
  });

  it("builds the navigation keybindings from the configured combos", function () {
    const defaults = navigationKeybindings();
    assert.deepStrictEqual(
      defaults.map((binding) => [binding.key, binding.run]),
      [
        ["Alt-ArrowLeft", navigateHistoryBack],
        ["Alt-ArrowRight", navigateHistoryForward],
      ],
      "the default bindings must run the production history commands on the Alt-Arrow defaults",
    );
    // The macOS variants of the DEFAULT bindings stay on Ctrl-Arrow (the
    // pre-existing platform mapping).
    assert.deepStrictEqual(
      defaults.map((binding) => binding.mac),
      ["Ctrl-ArrowLeft", "Ctrl-ArrowRight"],
    );

    const configured: NavigationShortcutConfig = { back: "Ctrl-Alt-1", forward: "Ctrl-Alt-2" };
    assert.deepStrictEqual(
      navigationKeybindings(configured).map((binding) => [binding.key, binding.run]),
      [
        ["Ctrl-Alt-1", navigateHistoryBack],
        ["Ctrl-Alt-2", navigateHistoryForward],
      ],
      "configured combos must replace the defaults while keeping the production commands",
    );
  });

  describe("real keydown dispatch through the built keymap", function () {
    const views: EditorView[] = [];
    const recorded: RecordedInvoke[] = [];
    // Detached from the preload's full ipc surface: the navigation commands
    // consume exactly invoke(), and the recorder provides exactly that.
    const windowWithIpc = window as unknown as {
      ipc?: { invoke: (channel: string, message: RecordedInvoke["message"]) => Promise<unknown> };
    };
    let previousIpc: typeof windowWithIpc.ipc;

    before(function () {
      polyfillJsdomForCodeMirror();
      // Provision the window.ipc preload seam the navigation commands
      // invoke; the recording implementation stands at the exact
      // renderer->main boundary the production preload owns.
      previousIpc = windowWithIpc.ipc;
      windowWithIpc.ipc = {
        invoke: async (channel, message) => {
          recorded.push({ channel, message });
          return true;
        },
      };
    });

    after(function () {
      windowWithIpc.ipc = previousIpc;
      for (const view of views.splice(0)) {
        view.destroy();
      }
      document.body.replaceChildren();
    });

    beforeEach(function () {
      recorded.splice(0);
    });

    function createEditor(navigation?: NavigationShortcutConfig): EditorView {
      const state = EditorState.create({
        doc: "Navigation scene",
        extensions: [
          editorMetadataFacet.of({ windowId: "window-1", leafId: "leaf-1" }),
          defaultKeymap(navigation),
        ],
      });
      const view = new EditorView({ state, parent: document.body });
      views.push(view);
      return view;
    }

    function press(view: EditorView, init: KeyboardEventInit): boolean {
      return runScopeHandlers(view, new KeyboardEvent("keydown", init), "editor");
    }

    function navigationCommands(): string[] {
      return recorded
        .filter((entry) => entry.channel === "documents-provider")
        .map((entry) => entry.message.command)
        .filter((command) => command === "navigate-back" || command === "navigate-forward");
    }

    it("the default keymap navigates on Alt-ArrowLeft/Alt-ArrowRight", function () {
      const view = createEditor();
      assert.strictEqual(press(view, { key: "ArrowLeft", altKey: true }), true);
      assert.strictEqual(press(view, { key: "ArrowRight", altKey: true }), true);
      assert.deepStrictEqual(navigationCommands(), ["navigate-back", "navigate-forward"]);
    });

    it("a configured combo navigates and the displaced default no longer does", function () {
      const view = createEditor({ back: "Ctrl-Alt-1", forward: "Ctrl-Alt-2" });

      assert.strictEqual(press(view, { key: "1", ctrlKey: true, altKey: true }), true);
      assert.strictEqual(press(view, { key: "2", ctrlKey: true, altKey: true }), true);
      assert.deepStrictEqual(navigationCommands(), ["navigate-back", "navigate-forward"]);

      // Excludes the broken always-Alt-Arrow implementation: with the
      // combos rebound, the old defaults must not issue history requests.
      recorded.splice(0);
      press(view, { key: "ArrowLeft", altKey: true });
      press(view, { key: "ArrowRight", altKey: true });
      assert.deepStrictEqual(navigationCommands(), []);
    });
  });
});
