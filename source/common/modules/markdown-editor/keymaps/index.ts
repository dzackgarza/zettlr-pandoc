/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        CodeMirror keymap entry point
 * CVM-Role:        CodeMirror Extension
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Defines and exposes an extension for the primary Zettlr keymap.
 *
 * END HEADER
 */

import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { registeredEditorKeybindings } from "@common/commands/command-registry";
import _ from "underscore";
import { configField, configUpdateEffect, type EditorConfiguration } from "../util/configuration";
import { mainEditorKeybindings } from "./default";
import { type CustomEditorShortcut } from "./shortcuts";

const keymapCompartment = new Compartment();

// This transaction extender listens for configUpdate effects and reconfigures
// the keymap accordingly
const keybindingsTransactionExtender = EditorState.transactionExtender.of((tr) => {
  let extendedTransaction = null;
  for (const effect of tr.effects) {
    if (
      effect.is(configUpdateEffect) &&
      !_.isEqual(effect.value.shortcuts, tr.startState.field(configField).shortcuts)
    ) {
      const keys = [
        ...registeredEditorKeybindings(effect.value.shortcuts),
        ...mainEditorKeybindings(effect.value.shortcuts, tr.state.field(configField)),
      ];
      extendedTransaction = {
        effects: keymapCompartment.reconfigure(keymap.of(keys)),
      };
    }
  }

  return extendedTransaction;
});

/**
 * Registers the Zettlr keymap including a transaction extender that keeps the
 * custom shortcuts updated whenever the config changes.
 *
 * @param   {CustomEditorShortcut[]}  customShortcutMap  The initial custom shortcuts
 *
 * @return  {Extension}                                  The keymap
 */
export function zettlrKeymap(
  customShortcutMap: CustomEditorShortcut[],
  config: Pick<EditorConfiguration, "autocompleteWithEnter" | "autocompleteWithTab">,
): Extension {
  return [
    keybindingsTransactionExtender,
    keymapCompartment.of(
      keymap.of([
        ...registeredEditorKeybindings(customShortcutMap),
        ...mainEditorKeybindings(customShortcutMap, config),
      ]),
    ),
  ];
}
