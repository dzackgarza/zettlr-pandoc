/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        File Manager Preferences Schema
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Exports the file manager tab schema.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import { reportError } from "@common/util/error-reporting";
import type { ConfigOptions } from "source/app/service-providers/config/get-config-template";
import { PreferencesGroups } from "./_preferences-groups";
import { type PreferencesFieldset } from "./types";

export function getFileManagerFields(
  config: Pick<ConfigOptions, "fileNameDisplay">,
): PreferencesFieldset[] {
  return [
    {
      title: trans("Display mode"),
      group: PreferencesGroups.FileManager,
      help: undefined, // TODO
      fields: [
        {
          type: "radio",
          model: "fileManagerMode",
          inline: true,
          options: {
            thin: trans("Thin"),
            expanded: trans("Expanded"),
            combined: trans("Combined"),
          },
        },
        {
          type: "form-text",
          display: "info",
          contents: trans(
            "The Thin mode shows your directories and files separately. Select a directory to have its contents displayed in the file list. Switch between file list and directory tree by clicking on directories or the arrow button which appears at the top left corner of the file list.",
          ),
        },
        { type: "separator" },
        {
          type: "checkbox",
          label: trans("Show file information"),
          model: "fileMeta",
        },
        {
          type: "checkbox",
          label: trans("Show folders above files"),
          model: "sortFoldersFirst",
        },
      ],
    },
    {
      title: trans("Markdown document name display"),
      infoString: trans(
        "Determines how Zettlr will display files in various places such as the file manager.",
      ),
      group: PreferencesGroups.FileManager,
      help: undefined, // TODO
      fields: [
        {
          type: "radio",
          model: "fileNameDisplay",
          options: {
            filename: trans("Filename only"),
            title: trans("Title if applicable"),
            heading: trans("First heading if applicable"),
            "title+heading": trans("Title or first heading if applicable"),
          },
        },
        {
          // TODO: Checkbox onto the first line of the radio
          type: "checkbox",
          label: trans("Display Markdown file extensions"),
          info: trans('Only available if name display is set to "Filename only"'),
          model: "display.markdownFileExtensions",
          disabled: config.fileNameDisplay !== "filename",
        },
      ],
    },
    {
      title: trans("File filters"),
      infoString: trans(
        'Gitignore rules decide which files and folders the app lists. One dialog edits them: the rules for all workspaces and the ".zettlrignore" file of each workspace. To list only some file types, start with "*" and "!*/", then add one "!*.md" line for each type.',
      ),
      group: PreferencesGroups.FileManager,
      help: undefined,
      fields: [
        {
          type: "button",
          label: trans("Edit file filters…"),
          onClick: () => {
            window.ipc
              .invoke("application", { command: "edit-ignore-rules" })
              .catch((err) => reportError(err));
          },
        },
      ],
    },
    {
      title: trans("Time display and sorting"),
      infoString: trans(
        "Determine which timestamp Zettlr shows for files. This also affects sorting by time.",
      ),
      group: PreferencesGroups.FileManager,
      help: undefined, // TODO
      fields: [
        {
          type: "radio",
          model: "fileMetaTime",
          options: {
            modtime: trans("Last modification time"),
            creationtime: trans("File creation time"),
          },
        },
      ],
    },
    {
      title: trans("Filename sorting"),
      infoString: trans("Determines how Zettlr sorts files and folders when sorting by name."),
      group: PreferencesGroups.FileManager,
      help: undefined, // TODO
      fields: [
        {
          type: "radio",
          label: trans("When sorting documents…"),
          model: "sorting",
          options: {
            natural: trans("Use natural order (2 comes before 10)"),
            ascii: trans("Use ASCII order (2 comes after 10)"),
          },
        },
      ],
    },
    {
      title: trans("Workspace sorting"),
      infoString: trans("Zettlr automatically sorts your workspaces by name."),
      group: PreferencesGroups.FileManager,
      help: undefined, // TODO
      fields: [
        {
          type: "checkbox",
          label: trans("Sort workspaces manually"),
          info: trans(
            "This will be active as soon as you manually change the sort order. Disable this to reinstate automatic sorting.",
          ),
          model: "fileManager.sortWorkspacesManually",
        },
      ],
    },
    {
      title: trans("Collapse Workspaces Behavior"),
      group: PreferencesGroups.FileManager,
      infoString: trans(
        "Determine how the context menu item to collapse workspaces in the file manager behaves. You can choose single-step or two-step.",
      ),
      help: undefined, // TODO
      fields: [
        {
          type: "checkbox",
          label: trans("Require two steps to collapse workspaces"),
          info: trans(
            "When this is active, the first collapse workspace will only collapse subfolders, the second the workspaces.",
          ),
          model: "fileManager.twoStepCollapseWorkspaces",
        },
      ],
    },
  ];
}
