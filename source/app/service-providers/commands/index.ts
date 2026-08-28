/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Command loader
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file simply imports all commands, and exports them in
 *                  a unified object for easy instantiation by zettlr.ts.
 *
 * END HEADER
 */

import type { FormatResult } from "@common/modules/markdown-editor/commands/format-document";
import type {
  CommitRenameOutcome,
  ReferenceRenamePreview,
  UndoRenameOutcome,
} from "@common/pandoc-util/compute-reference-edits";
import enumDictFiles from "@common/util/enum-dict-files";
import enumLangFiles from "@common/util/enum-lang-files";
import type { LinkPreviewResult } from "@common/util/fetch-link-preview";
import type { DocumentType } from "@dts/common/documents";
import type { MDFileDescriptor, ProjectSettings } from "@dts/common/fsal";
import type { WorkspaceReferenceEdit } from "@dts/common/references";
import ProviderContract, { type IPCMessage } from "@providers/provider-contract";
import { clipboard, ipcMain, nativeImage } from "electron";
import { type AppServiceContainer } from "source/app/app-service-container";
import type { TikzRenderRequest, TikzRenderResult } from "source/app/util/tikz-render";
import type { LanguageToolIgnoredRuleEntry } from "../config/get-config-template";
import DirDelete from "./dir-delete";
import DirNew from "./dir-new";
import DirNewProject from "./dir-new-project";
import DirProjectExport from "./dir-project-export";
import DirRemoveProject from "./dir-remove-project";
import DirRename from "./dir-rename";
import DirRescan from "./dir-rescan";
import type { DirSettingsCommandAPI } from "./dir-settings";
import DirSettings from "./dir-settings";
import DirSort from "./dir-sort";
import type { CustomExportIPCAPI, ExportIPCAPI } from "./export";
import Export from "./export";
import FetchLinkPreview from "./fetch-link-preview";
import FileDelete from "./file-delete";
import FileDuplicate from "./file-duplicate";
import type { FindFileAndReturnMetadataResult } from "./file-find-and-return-meta-data";
import FileFindAndReturnMetaData from "./file-find-and-return-meta-data";
import FileNew from "./file-new";
import FileRename from "./file-rename";
import FileSearch from "./file-search";
import type { ForceOpenAPI } from "./force-open";
import ForceOpen from "./force-open";
import FormatDocument from "./format-document";
import ImportFiles from "./import";
import ImportLangFile from "./import-lang-file";
import IncreasePomodoro from "./increase-pomodoro";
import type { LanguageToolLinterRequest, LanguageToolLinterResponse } from "./language-tool";
import LanguageTool from "./language-tool";
import OpenAttachment from "./open-attachment";
import type { ProgrammaticallyOpenableWindows } from "./open-aux-window";
import OpenAuxWindow from "./open-aux-window";
import Print from "./print";
import RenameReference from "./rename-reference";
import RenameTag from "./rename-tag";
import RequestMove from "./request-move";
import RootClose from "./root-close";
import RootOpen from "./root-open";
import type { SaveImageFromClipboardAPI } from "./save-image-from-clipboard";
import SaveImageFromClipboard from "./save-image-from-clipboard";
import TikzRender from "./tikz-render";
import TutorialOpen from "./tutorial-open";
import UpdateProjectProperties from "./update-project-properties";
import UpdateUserDictionary from "./update-user-dictionary";
import WorkspaceSort from "./ws-sort";
import type ZettlrCommand from "./zettlr-command";

export const commands = [
  DirDelete,
  DirNewProject,
  DirNew,
  DirProjectExport,
  DirRemoveProject,
  DirRename,
  DirRescan,
  DirSettings,
  DirSort,
  Export,
  FetchLinkPreview,
  FileDelete,
  FileDuplicate,
  FileNew,
  FileRename,
  FileSearch,
  FileFindAndReturnMetaData,
  ForceOpen,
  ImportFiles,
  ImportLangFile,
  IncreasePomodoro,
  LanguageTool,
  OpenAttachment,
  OpenAuxWindow,
  Print,
  RenameReference,
  RenameTag,
  FormatDocument,
  RequestMove,
  RootClose,
  RootOpen,
  SaveImageFromClipboard,
  TikzRender,
  TutorialOpen,
  UpdateProjectProperties,
  UpdateUserDictionary,
  WorkspaceSort,
];

/**
 * The wire contract of the 'application' ipc channel: every command the
 * renderer may run through CommandProvider.run(), with its payload and the
 * response that running it resolves to. This map is the single owner of the
 * channel's request AND response shape; the renderer's invoke type is
 * composed from it, so a wrong command, payload or response assumption fails
 * to compile at the call site. When a new command becomes renderer-invokable,
 * add it here.
 *
 * A `response: unknown` records that the command dispatches to
 * `ZettlrCommand.run()`, whose static type is `Promise<unknown>` — that is the
 * handler's honest static type today, not a gap to be guessed at. Narrow one
 * only by narrowing the command it dispatches to.
 */
export type ApplicationIPCContract = {
  "add-language-tool-ignore-rule": {
    request: { payload: LanguageToolIgnoredRuleEntry };
    response: unknown;
  };
  "commit-reference-rename": {
    request: { payload: { edit: WorkspaceReferenceEdit } };
    response: CommitRenameOutcome;
  };
  "custom-export": {
    request: { payload: CustomExportIPCAPI };
    response: unknown;
  };
  "dir-delete": {
    request: { payload: { path: string } };
    response: unknown;
  };
  "dir-new": {
    request: { payload: { path: string; name?: string } };
    response: unknown;
  };
  "dir-new-project": {
    request: { payload: { path: string } };
    response: unknown;
  };
  "dir-project-export": {
    request: { payload: string };
    response: unknown;
  };
  "dir-remove-project": {
    request: { payload: { path: string } };
    response: unknown;
  };
  "dir-rename": {
    request: { payload: { path: string; name: string } };
    response: unknown;
  };
  "dir-sort": {
    request: { payload: { path: string; sorting: string } };
    response: unknown;
  };
  export: {
    request: { payload: ExportIPCAPI };
    response: unknown;
  };
  "fetch-link-preview": {
    request: { payload: string };
    response: LinkPreviewResult | undefined;
  };
  "file-find-and-return-meta-data": {
    request: { payload: string };
    response: FindFileAndReturnMetadataResult | undefined;
  };
  "file-delete": {
    request: { payload: { path: string } };
    response: unknown;
  };
  "file-duplicate": {
    request: { payload: { path: string; windowId: string; leafId?: string; name?: string } };
    response: unknown;
  };
  "file-new": {
    request: { payload: { path?: string; name?: string; type?: DocumentType } };
    response: unknown;
  };
  "file-rename": {
    request: { payload: { path: string; name: string } };
    response: unknown;
  };
  "find-exact": {
    request: { payload: string };
    response: MDFileDescriptor | undefined;
  };
  "force-open": {
    request: { payload: ForceOpenAPI };
    response: unknown;
  };
  "format-document": {
    request: { payload: string };
    response: FormatResult;
  };
  // Answered inline by run(): enumDictFiles().map(elem => elem.tag).
  "get-available-dictionaries": {
    request: { payload?: undefined };
    response: string[];
  };
  // Answered inline by run(): enumLangFiles().map(elem => elem.tag).
  "get-available-languages": {
    request: { payload?: undefined };
    response: string[];
  };
  // Answered inline by run(): fsal.loadAnySupportedFile(), Promise<string>.
  "get-file-contents": {
    request: { payload: string };
    response: string;
  };
  "open-attachment": {
    request: { payload: { citekey: string; filePath: string } };
    response: unknown;
  };
  "open-aux-window": {
    request: { payload: { window: ProgrammaticallyOpenableWindows; hash?: string } };
    response: unknown;
  };
  // Answered inline by run(): shows the window, then returns true.
  "open-preferences": {
    request: { payload?: undefined };
    response: boolean;
  };
  // Answered inline by run(): shows the window and falls through without
  // returning, so invoke() resolves to undefined.
  "open-project-preferences": {
    request: { payload: string };
    response: undefined;
  };
  // Answered inline by run(): shows the window, then returns true.
  "open-stats-window": {
    request: { payload?: undefined };
    response: boolean;
  };
  // Answered inline by run(): shows the window and falls through without
  // returning, so invoke() resolves to undefined.
  "open-update-window": {
    request: { payload?: undefined };
    response: undefined;
  };
  "preview-reference-rename": {
    request: { payload: { oldKey: string; newKey: string } };
    response: ReferenceRenamePreview;
  };
  print: {
    request: { payload?: string };
    response: unknown;
  };
  "rename-tag": {
    request: { payload: { oldName: string; newName: string } };
    response: unknown;
  };
  "request-move": {
    request: { payload: { from: string; to: string } };
    response: unknown;
  };
  "root-close": {
    request: { payload: string };
    response: unknown;
  };
  "root-open-workspaces": {
    request: { payload?: undefined };
    response: unknown;
  };
  "root-open-files": {
    request: { payload?: undefined };
    response: unknown;
  };
  "roots-add": {
    request: { payload: string[] };
    response: unknown;
  };
  "run-language-tool": {
    request: { payload: LanguageToolLinterRequest };
    response: LanguageToolLinterResponse;
  };
  "save-image-from-clipboard": {
    request: { payload: SaveImageFromClipboardAPI | { startPath: string } };
    response: string | undefined;
  };
  "set-directory-setting": {
    request: { payload: DirSettingsCommandAPI };
    response: unknown;
  };
  "sort-workspaces": {
    request: { payload: string[] };
    response: unknown;
  };
  "tikz-render": {
    request: { payload: TikzRenderRequest };
    response: TikzRenderResult;
  };
  "undo-reference-rename": {
    request: { payload?: undefined };
    response: UndoRenameOutcome;
  };
  "update-project-properties": {
    request: { payload: { path: string; properties: ProjectSettings } };
    response: unknown;
  };
};

export type ApplicationIPCAPI = IPCMessage<ApplicationIPCContract>;

export default class CommandProvider extends ProviderContract {
  private readonly _commands: ZettlrCommand[];

  // TODO: Right now this just injects the full service container into the
  // commands, but it mayt be better to only provide those which are actually
  // required.
  constructor(private readonly _app: AppServiceContainer) {
    super();
    // Load available commands
    this._commands = commands.map((Command) => new Command(this._app));

    // Set up the command listener
    ipcMain.handle("application", async (event, { command, payload }) => {
      if (typeof command === "string") {
        return await this.run(command, payload);
      } else {
        throw new Error(`[Commands] Could not run command "${String(command)}": Not a string`);
      }
    });
  }

  /**
   * Runs a command through the application pipeline
   *
   * @param   {string}  command  The command to run
   * @param   {any}     payload  Any payload, as required depending on the command.
   *
   * @return  {Promise<any>}     The return from running the command
   */
  async run(command: string, payload: unknown): Promise<unknown> {
    // FIRST: Try to run a minimal command for which its own custom function
    // wouldn't make sense.
    if (command === "copy-img-to-clipboard") {
      // We should copy the contents of an image file to clipboard. Payload
      // contains the image path. We can rely on the Electron framework here.
      if (typeof payload !== "string") {
        return false;
      }

      let imgPath = payload;
      if (imgPath.startsWith("safe-file://")) {
        imgPath = imgPath.replace("safe-file://", "");
      } else if (imgPath.startsWith("file://")) {
        imgPath = imgPath.replace("file://", "");
      }

      // Due to the colons in the drive letters on Windows, the pathname will
      // look like this: /C:/Users/Documents/test.jpg
      // See: https://github.com/Zettlr/Zettlr/issues/5489
      if (/^\/[A-Z]:/i.test(imgPath)) {
        imgPath = imgPath.slice(1);
      }

      const img = nativeImage.createFromPath(imgPath);

      if (!img.isEmpty()) {
        clipboard.writeImage(img);
      }
      return true;
    } else if (command === "get-file-contents" && typeof payload === "string") {
      // Some renderer's editor has requested a file
      return await this._app.fsal.loadAnySupportedFile(payload);
    } else if (command === "open-preferences") {
      this._app.windows.showPreferences();
      return true;
    } else if (command === "open-stats-window") {
      this._app.windows.showStatsWindow();
      return true;
    } else if (command === "open-update-window") {
      this._app.windows.showUpdateWindow();
    } else if (command === "open-project-preferences" && typeof payload === "string") {
      this._app.windows.showProjectPropertiesWindow(payload);
    } else {
      // ELSE: If the command has not yet been found, try to run one of the
      // bigger commands
      const cmd: ZettlrCommand | undefined = this._commands.find((elem: ZettlrCommand) =>
        elem.respondsTo(command),
      );
      if (cmd !== undefined) {
        // Return the return value of the command, if there is any
        try {
          return await cmd.run(command, payload);
        } catch (err: unknown) {
          this._app.log.error(
            "[Application] Error received while running command: " +
              (err instanceof Error ? err.message : "Unknown error"),
            err,
          );
          return false;
        }
      } else if (command === "get-available-languages") {
        return enumLangFiles().map((elem) => elem.tag);
      } else if (command === "get-available-dictionaries") {
        return enumDictFiles().map((elem) => elem.tag);
      } else {
        // Nothing answered for this name. The result channel is the caller's
        // only evidence of what happened, and ipcMain.handle turns a plain
        // return into a RESOLVED invoke() — so logging and falling out would
        // report success for work that never ran. Throwing is what keeps an
        // unimplemented command indistinguishable from a failing one.
        throw new Error(`[Commands] Could not run command "${command}": Not registered.`);
      }
    }
  }

  async shutdown(): Promise<void> {
    this._app.log.verbose("Command Provider shutting down ...");
  }
}
