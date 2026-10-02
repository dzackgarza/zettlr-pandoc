/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Configurable navigation shortcut specs (issue #1, review A8)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks the per-pane Back/Forward navigation combos onto
 *                  Zettlr's custom editor shortcut registry (issue #1
 *                  workstream 4): the registry supplies the Alt-Arrow
 *                  defaults, and a user-configured combo displaces them.
 *                  The dispatch proof drives a real EditorView through
 *                  CodeMirror's own scope handler with real KeyboardEvents;
 *                  the observation point is the window.ipc preload seam the
 *                  navigation commands invoke ('documents-provider'
 *                  navigate-back/navigate-forward), provisioned by the spec
 *                  exactly as the production preload provides it.
 *
 * END HEADER
 */

import { EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { strict as assert } from "assert";
import { zettlrKeymap } from "source/common/modules/markdown-editor/keymaps";
import {
  type CustomEditorShortcut,
  defaultKeybindings,
} from "source/common/modules/markdown-editor/keymaps/shortcuts";
import { editorMetadataFacet } from "source/common/modules/markdown-editor/plugins/editor-metadata";
import {
  configField,
  getDefaultConfig,
} from "source/common/modules/markdown-editor/util/configuration";

/** One recorded renderer->main request at the window.ipc preload seam. */
interface RecordedInvoke {
  channel: string;
  message: { command: string; payload?: unknown };
}

describe("Configurable navigation shortcuts (review A8)", function () {
  it("registers the Alt-Arrow defaults, with the macOS Ctrl-Arrow variants", function () {
    assert.deepStrictEqual(
      [defaultKeybindings["nav-history-back"], defaultKeybindings["nav-history-forward"]],
      [
        { key: "Alt-ArrowLeft", mac: "Ctrl-ArrowLeft" },
        { key: "Alt-ArrowRight", mac: "Ctrl-ArrowRight" },
      ],
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

    function createEditor(shortcuts: CustomEditorShortcut[] = []): EditorView {
      const state = EditorState.create({
        doc: "Navigation scene",
        extensions: [
          configField,
          editorMetadataFacet.of({ windowId: "window-1", leafId: "leaf-1" }),
          zettlrKeymap(shortcuts, getDefaultConfig()),
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
      const view = createEditor([
        { name: "nav-history-back", shortcut: "Ctrl-Alt-1" },
        { name: "nav-history-forward", shortcut: "Ctrl-Alt-2" },
      ]);

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
