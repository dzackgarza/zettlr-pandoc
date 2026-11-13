/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Explorer view choices of one folder
 * CVM-Role:        Controller
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The display, sort, direction, grouping and project-file
 *                  choices of a folder, as menu items and as functions that
 *                  write them. Each control that changes the order of a folder
 *                  (its context menu, its Properties, the Workspaces menu)
 *                  uses these functions with the folder that the author names.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import type { AnyMenuItem } from "@common/modules/window-register/application-menu-helper";
import { useConfigStore } from "source/pinia";
import type {
  DirDescriptor,
  DirectoryExplorerSettings,
  FileNameDisplay,
  ProjectFileFilter,
  SortMethod,
} from "source/types/common/fsal";
import { ref } from "vue";
import { updateExplorerDirectory } from "./update-explorer-directory";

export type SortChoice =
  | "display"
  | "filename"
  | "title"
  | "heading"
  | "modified"
  | "created"
  | "manual"
  | "metadata"
  | "book";
export type Direction = "up" | "down";
type FoldersMode = "inherit" | "folders" | "mixed";

/** The key of the front matter field that orders a folder by hand. */
const MANUAL_ORDER_KEY = "zettlr-order_";

/**
 * A request of a menu to edit the metadata field of a folder. The file tree
 * shows the editor at the anchor.
 */
export interface MetadataKeyRequest {
  path: string;
  anchor: HTMLElement;
}

export const metadataKeyRequest = ref<MetadataKeyRequest | null>(null);

function sortPrefix(method: SortMethod): string {
  return method.slice(0, method.lastIndexOf("-"));
}

function sortSuffix(method: SortMethod): Direction {
  return method.endsWith("-down") ? "down" : "up";
}

export function choiceForDirectory(directory: DirDescriptor): SortChoice {
  const prefix = sortPrefix(directory.settings.sorting);
  if (prefix === "name") return "display";
  if (prefix === "time")
    return useConfigStore().config.fileMetaTime === "modtime" ? "modified" : "created";
  if (prefix === "modtime") return "modified";
  if (prefix === "creationtime") return "created";
  if (prefix === "frontmatter") {
    return directory.settings.explorer.sortMetadataKey === MANUAL_ORDER_KEY ? "manual" : "metadata";
  }
  return prefix as SortChoice;
}

/** The direction in which the author reads the order: `time-up` is newest first. */
export function directionForDirectory(directory: DirDescriptor): Direction {
  const suffix = sortSuffix(directory.settings.sorting);
  if (sortPrefix(directory.settings.sorting) !== "time") {
    return suffix;
  }
  return suffix === "up" ? "down" : "up";
}

function methodFor(choice: SortChoice, direction: Direction): SortMethod {
  const prefix =
    choice === "display"
      ? "name"
      : choice === "modified"
        ? "modtime"
        : choice === "created"
          ? "creationtime"
          : choice === "manual" || choice === "metadata"
            ? "frontmatter"
            : choice;
  return `${prefix}-${direction}` as SortMethod;
}

function setDisplay(directory: DirDescriptor, value: "inherit" | FileNameDisplay): Promise<void> {
  return updateExplorerDirectory(directory, () => ({}), { displayName: value });
}

/** Sorts the folder by a choice. The direction of the folder stays. */
export function setSort(directory: DirDescriptor, value: SortChoice): Promise<void> {
  const explorerPatch: Partial<DirectoryExplorerSettings> =
    value === "manual" ? { sortMetadataKey: MANUAL_ORDER_KEY } : {};
  return updateExplorerDirectory(
    directory,
    (stored) => ({ sorting: methodFor(value, directionForDirectory(stored)) }),
    explorerPatch,
  );
}

/** Reverses the order of the folder. Its sort and its metadata field stay. */
export function setDirection(directory: DirDescriptor, value: Direction): Promise<void> {
  return updateExplorerDirectory(directory, (stored) => ({
    sorting: methodFor(choiceForDirectory(stored), value),
  }));
}

/** Sorts the folder by the front matter field `key`. The direction stays. */
export function setMetadataKey(directory: DirDescriptor, key: string): Promise<void> {
  return updateExplorerDirectory(
    directory,
    (stored) => ({ sorting: methodFor("metadata", directionForDirectory(stored)) }),
    { sortMetadataKey: key },
  );
}

function setGrouping(directory: DirDescriptor, value: FoldersMode): Promise<void> {
  return updateExplorerDirectory(directory, () => ({}), {
    foldersFirst: value === "inherit" ? null : value === "folders",
  });
}

function setProjectFilter(directory: DirDescriptor, value: ProjectFileFilter): Promise<void> {
  return updateExplorerDirectory(directory, () => ({}), { projectFilter: value });
}

/** The labels of the sort choices that a folder offers, in menu order. */
export function sortChoiceLabels(directory: DirDescriptor): Array<[SortChoice, string]> {
  const key = directory.settings.explorer.sortMetadataKey;
  const metadataLabel =
    choiceForDirectory(directory) === "metadata"
      ? trans("Metadata field: %s", key)
      : trans("Metadata field…");
  const labels: Array<[SortChoice, string]> = [
    ["display", trans("Displayed name")],
    ["filename", trans("Filename")],
    ["title", trans("Title")],
    ["heading", trans("First heading")],
    ["modified", trans("Modified")],
    ["created", trans("Created")],
    ["manual", trans("Manual order (zettlr-order_)")],
    ["metadata", metadataLabel],
  ];
  if (directory.settings.project !== null) {
    labels.push(["book", trans("Book / Project order")]);
  }
  return labels;
}

function radioItem(id: string, label: string, checked: boolean): AnyMenuItem {
  return { id, label, type: "radio", checked };
}

const SORT_ITEM_PREFIX = "explorer-sort-";

/**
 * The view items of a folder for a context menu. Without a folder the items
 * are there and disabled.
 */
export function explorerViewItems(directory: DirDescriptor | undefined): AnyMenuItem[] {
  const displayAsLabel = trans("Display as");
  const sortByLabel = trans("Sort by");
  const directionLabel = trans("Direction");
  const groupingLabel = trans("Grouping");
  const defaultLabel = trans("Default");

  if (directory === undefined) {
    return [
      {
        id: "explorer-display",
        label: displayAsLabel,
        type: "submenu",
        enabled: false,
        submenu: [],
      },
      { id: "explorer-sort", label: sortByLabel, type: "submenu", enabled: false, submenu: [] },
      {
        id: "explorer-direction",
        label: directionLabel,
        type: "submenu",
        enabled: false,
        submenu: [],
      },
      {
        id: "explorer-grouping",
        label: groupingLabel,
        type: "submenu",
        enabled: false,
        submenu: [],
      },
    ];
  }

  const sortChoice = choiceForDirectory(directory);
  const direction = directionForDirectory(directory);
  const display = directory.settings.explorer.displayName;
  const folders =
    directory.settings.explorer.foldersFirst === null
      ? "inherit"
      : directory.settings.explorer.foldersFirst
        ? "folders"
        : "mixed";
  const filter = directory.settings.explorer.projectFilter;
  const project = directory.settings.project;

  const items: AnyMenuItem[] = [
    {
      id: "explorer-display",
      label: displayAsLabel,
      type: "submenu",
      submenu: [
        radioItem("explorer-display-inherit", defaultLabel, display === "inherit"),
        radioItem("explorer-display-filename", trans("Filename"), display === "filename"),
        radioItem("explorer-display-title", trans("Title"), display === "title"),
        radioItem("explorer-display-heading", trans("First heading"), display === "heading"),
        radioItem(
          "explorer-display-title-heading",
          trans("Title or first heading"),
          display === "title+heading",
        ),
      ],
    },
    {
      id: "explorer-sort",
      label: sortByLabel,
      type: "submenu",
      submenu: sortChoiceLabels(directory).map(([choice, label]) =>
        radioItem(`${SORT_ITEM_PREFIX}${choice}`, label, sortChoice === choice),
      ),
    },
    {
      id: "explorer-direction",
      label: directionLabel,
      type: "submenu",
      submenu: [
        radioItem("explorer-direction-up", trans("Ascending"), direction === "up"),
        radioItem("explorer-direction-down", trans("Descending"), direction === "down"),
      ],
    },
    {
      id: "explorer-grouping",
      label: groupingLabel,
      type: "submenu",
      enabled: sortChoice !== "book",
      submenu: [
        radioItem("explorer-grouping-inherit", defaultLabel, folders === "inherit"),
        radioItem("explorer-grouping-folders", trans("Folders first"), folders === "folders"),
        radioItem("explorer-grouping-mixed", trans("Mixed"), folders === "mixed"),
      ],
    },
  ];

  if (project !== null) {
    items.push({
      id: "explorer-project-files",
      label: project.manifest.kind === "quarto" ? trans("Book files") : trans("Project files"),
      type: "submenu",
      submenu: [
        radioItem("explorer-project-all", trans("All"), filter === "all"),
        radioItem("explorer-project-included", trans("Included"), filter === "included"),
        radioItem("explorer-project-omitted", trans("Not included"), filter === "omitted"),
      ],
    });
  }

  return items;
}

const DISPLAY_CHOICES: Record<string, "inherit" | FileNameDisplay> = {
  "explorer-display-inherit": "inherit",
  "explorer-display-filename": "filename",
  "explorer-display-title": "title",
  "explorer-display-heading": "heading",
  "explorer-display-title-heading": "title+heading",
};
const DIRECTION_CHOICES: Record<string, Direction> = {
  "explorer-direction-up": "up",
  "explorer-direction-down": "down",
};
const GROUPING_CHOICES: Record<string, FoldersMode> = {
  "explorer-grouping-inherit": "inherit",
  "explorer-grouping-folders": "folders",
  "explorer-grouping-mixed": "mixed",
};
const PROJECT_FILTER_CHOICES: Record<string, ProjectFileFilter> = {
  "explorer-project-all": "all",
  "explorer-project-included": "included",
  "explorer-project-omitted": "omitted",
};
const SORT_CHOICES: Record<string, SortChoice> = Object.fromEntries(
  (
    [
      "display",
      "filename",
      "title",
      "heading",
      "modified",
      "created",
      "manual",
      "metadata",
      "book",
    ] as const
  ).map((choice) => [`${SORT_ITEM_PREFIX}${choice}`, choice]),
);

/**
 * Applies a view item of `explorerViewItems` to the folder. The metadata
 * choice asks for the field at `anchor`. Other items are not view items and
 * change nothing.
 */
export function handleExplorerMenuChoice(
  directory: DirDescriptor,
  clickedID: string,
  anchor: HTMLElement,
): void {
  const sort = SORT_CHOICES[clickedID];
  if (sort === "metadata") {
    metadataKeyRequest.value = { path: directory.path, anchor };
  } else if (sort !== undefined) {
    setSort(directory, sort);
  } else if (clickedID in DISPLAY_CHOICES) {
    setDisplay(directory, DISPLAY_CHOICES[clickedID]);
  } else if (clickedID in DIRECTION_CHOICES) {
    setDirection(directory, DIRECTION_CHOICES[clickedID]);
  } else if (clickedID in GROUPING_CHOICES) {
    setGrouping(directory, GROUPING_CHOICES[clickedID]);
  } else if (clickedID in PROJECT_FILTER_CHOICES) {
    setProjectFilter(directory, PROJECT_FILTER_CHOICES[clickedID]);
  }
}
