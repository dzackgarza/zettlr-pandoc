/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The export items of the application
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     An export item is one thing that an author exports with.
 *                  Each item has one engine: a Pandoc defaults file, the PDF
 *                  recipe of ~/.pandoc, a bundle writer, or a command. An
 *                  item with a Pandoc engine can run a command on the file
 *                  that Pandoc wrote.
 *
 *                  The items come from three places, and `exportItems` makes
 *                  the one list of them: the defaults files of the author,
 *                  the items of the application (PDF, Textbundle, Textpack),
 *                  and the items of the settings (`export.items`). Each
 *                  surface that offers an export and each code path that
 *                  runs one reads this list.
 *
 * END HEADER
 */

import type { PandocProfileMetadata } from "@providers/assets";
import type { ConfigOptions } from "@providers/config/get-config-template";

/** An export item as the settings declare it (`export.items`). */
export type SettingsExportItem = ConfigOptions["export"]["items"][number];

/** How an export item makes its file. */
export type ExportEngine =
  /** Pandoc with a defaults file of the author. */
  | {
      kind: "pandoc";
      /** The file name of the defaults file */
      defaultsFile: string;
      reader: string;
      writer: string;
      /** The template that the defaults file declares, if any */
      template: string | undefined;
    }
  /** The PDF recipe of ~/.pandoc, which owns each flag of the PDF. */
  | { kind: "recipe"; recipe: "compile-pandoc" }
  /** A bundle of the text and its figures, made without Pandoc. */
  | { kind: "bundle"; format: "textbundle" | "textpack" }
  /**
   * A command of the author. It gets the document, or the folder of a
   * Project, as its one argument.
   */
  | { kind: "command"; command: string };

/** A command that runs on the file that the Pandoc engine of an item wrote. */
export interface PostStage {
  /** The command; it gets the file of Pandoc and the file to write. */
  command: string;
  /** The extension of the file that the command writes */
  extension: string;
}

/** Where an export item is declared. */
export type ExportItemOrigin = "defaults-file" | "application" | "settings";

interface ExportItemBase {
  /**
   * The identity of the item: the file name of a defaults file, the name of
   * an item of the application, or the name of an item of the settings. A
   * Project and the remembered choice of a document store it.
   */
  id: string;
  origin: ExportItemOrigin;
}

/** An export item that the application can run. */
export interface ExportItem extends ExportItemBase {
  isInvalid: false;
  engine: ExportEngine;
  post: PostStage | undefined;
}

/** An export item that cannot run; `reason` says why. */
export interface InvalidExportItem extends ExportItemBase {
  isInvalid: true;
  reason: string;
}

export type ExportItemEntry = ExportItem | InvalidExportItem;

/** The items that the application declares. */
const APPLICATION_ITEMS: ExportItem[] = [
  {
    id: "PDF.yaml",
    origin: "application",
    isInvalid: false,
    engine: { kind: "recipe", recipe: "compile-pandoc" },
    post: undefined,
  },
  {
    id: "Textbundle.yaml",
    origin: "application",
    isInvalid: false,
    engine: { kind: "bundle", format: "textbundle" },
    post: undefined,
  },
  {
    id: "Textpack.yaml",
    origin: "application",
    isInvalid: false,
    engine: { kind: "bundle", format: "textpack" },
    post: undefined,
  },
];

/** The item of one defaults file. */
function itemOfDefaultsFile(profile: PandocProfileMetadata): ExportItemEntry {
  if (profile.isInvalid) {
    return { id: profile.name, origin: "defaults-file", isInvalid: true, reason: profile.reason };
  }
  return {
    id: profile.name,
    origin: "defaults-file",
    isInvalid: false,
    engine: {
      kind: "pandoc",
      defaultsFile: profile.name,
      reader: profile.reader,
      writer: profile.writer,
      template: profile.template,
    },
    post: undefined,
  };
}

/**
 * The item of one entry of `export.items`. An entry without a base is a
 * command on the document. An entry with a base runs the defaults file of
 * that name and then its command on the file that Pandoc wrote.
 */
function itemOfSettings(
  entry: SettingsExportItem,
  defaults: PandocProfileMetadata[],
): ExportItemEntry {
  const base = { id: entry.name, origin: "settings" } as const;
  if (APPLICATION_ITEMS.some((item) => item.id === entry.name)) {
    return {
      ...base,
      isInvalid: true,
      reason: `The name "${entry.name}" is the name of an export of the application.`,
    };
  }
  if (entry.command.trim() === "") {
    return { ...base, isInvalid: true, reason: "The export item has no command." };
  }
  if (entry.base === "") {
    return {
      ...base,
      isInvalid: false,
      engine: { kind: "command", command: entry.command },
      post: undefined,
    };
  }
  const profile = defaults.find((candidate) => candidate.name === entry.base);
  if (profile === undefined) {
    return {
      ...base,
      isInvalid: true,
      reason: `The base "${entry.base}" of the export item is no defaults file.`,
    };
  }
  if (profile.isInvalid) {
    return {
      ...base,
      isInvalid: true,
      reason: `The base "${entry.base}" of the export item cannot run: ${profile.reason}`,
    };
  }
  if (entry.extension.trim() === "") {
    return {
      ...base,
      isInvalid: true,
      reason: "The export item has a base and no extension for the file that its command writes.",
    };
  }
  return {
    ...base,
    isInvalid: false,
    engine: {
      kind: "pandoc",
      defaultsFile: profile.name,
      reader: profile.reader,
      writer: profile.writer,
      template: profile.template,
    },
    post: { command: entry.command, extension: entry.extension },
  };
}

/**
 * The export items of the application, one for each identity.
 *
 * An item of the application replaces a defaults file of its name:
 * userData/defaults is copied once and never pruned, so it can hold a
 * PDF.yaml of a version before the PDF recipe. An item of the settings
 * replaces a defaults file of its name too. Two items of the settings with
 * one name are both invalid: a Project that names the item would run one of
 * them by its place in the list.
 *
 * @param   {PandocProfileMetadata[]}  defaults  Each defaults file of the author
 * @param   {SettingsExportItem[]}     settings  The items of `export.items`
 *
 * @return  {ExportItemEntry[]}                  The items: the defaults files,
 *                                               the items of the application,
 *                                               the items of the settings
 */
export function exportItems(
  defaults: PandocProfileMetadata[],
  settings: SettingsExportItem[],
): ExportItemEntry[] {
  const settingsNames = settings.map((entry) => entry.name);
  const fromSettings = settings.map((entry): ExportItemEntry => {
    if (settingsNames.filter((name) => name === entry.name).length > 1) {
      return {
        id: entry.name,
        origin: "settings",
        isInvalid: true,
        reason: `More than one export item of the settings has the name "${entry.name}".`,
      };
    }
    return itemOfSettings(entry, defaults);
  });
  const replaced = new Set([...APPLICATION_ITEMS.map((item) => item.id), ...settingsNames]);
  return [
    ...defaults.filter((profile) => !replaced.has(profile.name)).map(itemOfDefaultsFile),
    ...APPLICATION_ITEMS,
    ...fromSettings,
  ];
}

/**
 * What an author reads as the kind of an item, beside its name: the writer
 * of Pandoc, "script" for a Pandoc engine with a command after it, the
 * recipe, the format of the bundle, or "command".
 */
export function exportItemKind(item: ExportItem): string {
  if (item.post !== undefined) {
    return "script";
  }
  switch (item.engine.kind) {
    case "pandoc":
      return item.engine.writer;
    case "recipe":
      return item.engine.recipe;
    case "bundle":
      return item.engine.format;
    case "command":
      return "command";
  }
}

/**
 * Finds the item that an entry of the profile list of a Project names. An
 * entry is the identity of an item. A Project file from before the export
 * items names an export command by its command line; such an entry is the
 * command item with that command line.
 */
export function exportItemOfProjectEntry(
  entry: string,
  items: ExportItemEntry[],
): ExportItemEntry | undefined {
  const byIdentity = items.find((item) => item.id === entry);
  if (byIdentity !== undefined) {
    return byIdentity;
  }
  return items.find(
    (item) => !item.isInvalid && item.engine.kind === "command" && item.engine.command === entry,
  );
}
