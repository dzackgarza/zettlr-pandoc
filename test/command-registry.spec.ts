/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Registered command shortcut contract
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Proves that one registered editor command supplies its
 *                  shortcut configuration, Preferences field, scoped
 *                  conflict behavior, and real CodeMirror execution.
 *
 * END HEADER
 */

import { EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { strict as assert } from "assert";
import {
  commandRegistry,
  createShortcutConfig,
  getCommandConflicts,
} from "source/common/commands/command-registry";
import { zettlrKeymap } from "source/common/modules/markdown-editor/keymaps";
import { ANNOTATE_SELECTION_EVENT } from "source/common/modules/markdown-editor/plugins/annotate-selection";
import { getDefaultConfig } from "source/common/modules/markdown-editor/util/configuration";
import { getShortcutFields } from "source/win-preferences/schema/shortcuts";

describe("Registered commands", function () {
  const views: EditorView[] = [];

  afterEach(function () {
    for (const view of views.splice(0)) {
      view.destroy();
    }
    document.body.replaceChildren();
  });

  it("derives configuration and Preferences from the annotate registration", function () {
    const command = commandRegistry.get("annotate-selection");
    assert.deepEqual(command, {
      id: "annotate-selection",
      label: "Annotate for AI…",
      group: "Editing",
      scope: "editor",
      when: "editorHasSelection",
      defaultKeybinding: {},
      palette: true,
      run: command?.run,
    });

    const shortcuts = createShortcutConfig();
    assert.equal(shortcuts.editor["annotate-selection"], "");

    const fields = getShortcutFields({ shortcuts }).flatMap((fieldset) => fieldset.fields);
    assert.ok(
      fields.some(
        (field) =>
          field.type === "shortcut" &&
          field.model === "shortcuts.editor.annotate-selection" &&
          field.label === "Annotate for AI…",
      ),
      "a registered command must produce its Preferences shortcut field",
    );
  });

  it("reports each binding that fires for the same key, in each scope and spelling", function () {
    // A key that the editor takes never reaches a window command, so an
    // editor and a window binding of one key conflict too (#202).
    const shortcuts = createShortcutConfig();
    shortcuts.editor["annotate-selection"] = "Ctrl-Shift-1";
    shortcuts.editor["nav-history-back"] = "Ctrl-Shift-1";
    shortcuts.ui["next-tab"] = "Ctrl-Shift-1";
    // CodeMirror reads an upper-case letter as the letter with Shift.
    shortcuts.editor["md-bold"] = "Ctrl-Shift-y";
    shortcuts.editor["md-italic"] = "Ctrl-Y";

    assert.deepEqual(getCommandConflicts("annotate-selection", shortcuts), [
      "nav-history-back",
      "next-tab",
    ]);
    assert.deepEqual(getCommandConflicts("next-tab", shortcuts), [
      "annotate-selection",
      "nav-history-back",
    ]);
    assert.deepEqual(getCommandConflicts("md-bold", shortcuts), ["md-italic"]);
  });

  it("gives no two commands one key in the default configuration", function () {
    const shortcuts = createShortcutConfig();
    const conflicts = Object.fromEntries(
      commandRegistry
        .all()
        .map((command) => [command.id, getCommandConflicts(command.id, shortcuts)] as const)
        .filter(([, others]) => others.length > 0),
    );
    assert.deepEqual(conflicts, {});
  });

  it("runs a configured selection command through the real editor keymap", function () {
    const text = "Register this command.";
    const from = text.indexOf("this");
    const to = from + "this command".length;
    const view = new EditorView({
      state: EditorState.create({
        doc: text,
        selection: { anchor: from, head: to },
        extensions: [
          zettlrKeymap(
            [{ name: "annotate-selection", shortcut: "Ctrl-Shift-1" }],
            getDefaultConfig(),
          ),
        ],
      }),
      parent: document.body,
    });
    views.push(view);

    let detail: { from: number; to: number } | undefined;
    view.dom.addEventListener(ANNOTATE_SELECTION_EVENT, (event) => {
      detail = (event as CustomEvent<{ from: number; to: number }>).detail;
    });

    const handled = runScopeHandlers(
      view,
      new KeyboardEvent("keydown", { key: "1", ctrlKey: true, shiftKey: true }),
      "editor",
    );
    assert.equal(handled, true);
    assert.deepEqual(detail, { from, to });
  });
});
