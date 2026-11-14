/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Export Preferences Schema
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Exports the export tab schema.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import { reportError } from "@common/util/error-reporting";
import { quickTexProblemMessage } from "@common/util/quicktex-problem";
import { showRefusal } from "@common/util/show-refusal";
import type { QuickTexProblem } from "@dts/common/quicktex";
import { ProgrammaticallyOpenableWindows } from "@providers/commands/open-aux-window";
import type { ConfigOptions } from "source/app/service-providers/config/get-config-template";
import { PreferencesGroups } from "./_preferences-groups";
import { type PreferencesFieldset } from "./types";

const ipcRenderer = window.ipc;

/**
 * @param  config           The settings that the form shows
 * @param  quickTexProblem  The setting of the QuickTeX configuration that the
 *                          assets provider could not use
 */
export function getSnippetsFields(
  config: ConfigOptions,
  quickTexProblem: QuickTexProblem | undefined,
): PreferencesFieldset[] {
  // A problem belongs to the value that the provider read. While the author
  // types another value, the field has no problem of its own yet.
  const problemOf = (setting: QuickTexProblem["setting"]): string | undefined => {
    const value =
      setting === "editor.quickTexFile"
        ? config.editor.quickTexFile
        : config.editor.quickTexPluginDirectory;
    return quickTexProblem?.setting === setting && quickTexProblem.path === value
      ? quickTexProblemMessage(quickTexProblem)
      : undefined;
  };

  return [
    {
      title: trans("Snippets"),
      group: PreferencesGroups.Snippets,
      infoString: trans(
        "Use a VS Code .code-snippets file for snippets. QuickTeX uses a separate Vimscript configuration.",
      ),
      help: undefined, // TODO
      fields: [
        {
          type: "file",
          label: trans("Snippets file"),
          model: "editor.snippetsFile",
          placeholder: trans("Path to .code-snippets file"),
          filter: [{ extensions: ["code-snippets"], name: "VS Code snippets" }],
        },
        {
          type: "file",
          label: trans("QuickTeX configuration"),
          model: "editor.quickTexFile",
          placeholder: trans("Path to QuickTeX Vimscript configuration"),
          reset: "",
          filter: [{ extensions: ["vim"], name: "Vimscript" }],
          problem: problemOf("editor.quickTexFile"),
        },
        {
          type: "directory",
          label: trans("QuickTeX plugin directory"),
          model: "editor.quickTexPluginDirectory",
          placeholder: trans("Path to the QuickTeX plugin root"),
          reset: "",
          problem: problemOf("editor.quickTexPluginDirectory"),
        },
        {
          type: "button",
          label: trans("Open snippets editor"),
          onClick: () => {
            ipcRenderer
              .invoke("application", {
                command: "open-aux-window",
                payload: {
                  window: ProgrammaticallyOpenableWindows.AssetsWindow,
                  hash: "tab-snippets-control",
                },
              })
              .catch((err) => reportError(err));
          },
        },
        {
          type: "button",
          label: trans("Open phrase completion dictionary"),
          onClick: () => {
            ipcRenderer
              .invoke("assets-provider", {
                command: "open-phrase-completions-directory",
              })
              .catch(showRefusal);
          },
        },
      ],
    },
  ];
}
