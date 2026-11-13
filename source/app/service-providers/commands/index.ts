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

import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type {
  ExternalLinterRunRequest,
  ExternalLinterRunResponse,
} from "@common/diagnostics/external-linter";
import { trans } from "@common/i18n-main";
import type { FormatResult } from "@common/modules/markdown-editor/commands/format-document";
import type {
  CommitRenameOutcome,
  ReferenceRenamePreview,
  UndoRenameOutcome,
} from "@common/pandoc-util/compute-reference-edits";
import enumDictFiles from "@common/util/enum-dict-files";
import enumLangFiles from "@common/util/enum-lang-files";
import type { LinkPreviewResult } from "@common/util/fetch-link-preview";
import type { CitationDatabase } from "@dts/common/citeproc";
import { COMMAND_FAILED_CHANNEL, type CommandFailedBroadcast } from "@dts/common/command-failure";
import type { DocumentType } from "@dts/common/documents";
import type { FixAllOutcome, FixAllPlan, FixAllRequest } from "@dts/common/fix-all";
import type { ProjectSettings } from "@dts/common/fsal";
import type { JustfileListing, RunJustRecipeRequest } from "@dts/common/justfile-commands";
import type { PreferenceNavigationTarget } from "@dts/common/preferences";
import type {
  ApplyProblemFixRequest,
  ListProblemsRequest,
  WorkspaceProblems,
} from "@dts/common/problems";
import type { CrossReferenceSystem, WorkspaceReferenceEdit } from "@dts/common/references";
import type { TikzRenderRequest, TikzRenderResult } from "@dzack/tikz-render/tikz-render";
import ProviderContract, { type IPCMessage } from "@providers/provider-contract";
import { clipboard, ipcMain, nativeImage, type WebContents } from "electron";
import { type AppServiceContainer } from "source/app/app-service-container";
import {
  documentBibliography,
  documentCrossReferenceSystem,
} from "source/app/util/document-bibliographies";
import { filePathOfUri } from "source/app/util/file-uri-path";
import { discoverJustfileCommands } from "source/app/util/justfile-commands";
import { justRecipeCommand, launchKitty } from "source/app/util/kitty-launch";
import { openPath } from "source/app/util/open-path";
import type { LanguageToolIgnoredRuleEntry } from "../config/get-config-template";
import type { RecentFiles } from "../recent-docs";
import AddLanguageToolIgnoreRule from "./add-language-tool-ignore-rule";
import type {
  DirBindQuartoManifestAPI,
  DirBindQuartoManifestOutcome,
} from "./dir-bind-quarto-manifest";
import DirBindQuartoManifest from "./dir-bind-quarto-manifest";
import DirDelete from "./dir-delete";
import DirNew from "./dir-new";
import DirNewProject from "./dir-new-project";
import DirProjectExport from "./dir-project-export";
import DirRemoveProject from "./dir-remove-project";
import DirRename from "./dir-rename";
import DirRescan from "./dir-rescan";
import type { DirSettingsCommandAPI } from "./dir-settings";
import DirSettings from "./dir-settings";
import type { CustomExportIPCAPI, ExportIPCAPI } from "./export";
import Export from "./export";
import FetchLinkPreview from "./fetch-link-preview";
import FileDelete from "./file-delete";
import FileDuplicate from "./file-duplicate";
import type {
  FindFileAndReturnMetadataRequest,
  FindFileAndReturnMetadataResult,
} from "./file-find-and-return-meta-data";
import FileFindAndReturnMetaData from "./file-find-and-return-meta-data";
import FileNew from "./file-new";
import FileRename from "./file-rename";
import FixAll from "./fix-all";
import type { ForceOpenAPI } from "./force-open";
import ForceOpen from "./force-open";
import FormatDocument, { type FormatDocumentRequest } from "./format-document";
import ImportFiles from "./import";
import ImportLangFile from "./import-lang-file";
import IncreasePomodoro from "./increase-pomodoro";
import OpenAttachment from "./open-attachment";
import type { ProgrammaticallyOpenableWindows } from "./open-aux-window";
import OpenAuxWindow from "./open-aux-window";
import Print from "./print";
import QuartoBookEditCommand, { type QuartoBookEditRequest } from "./quarto-book-edit";
import RenameReference from "./rename-reference";
import RenameTag from "./rename-tag";
import RequestMove from "./request-move";
import RootClose from "./root-close";
import RootOpen from "./root-open";
import RunExternalLinter from "./run-external-linter";
import type { SaveImageFromClipboardAPI } from "./save-image-from-clipboard";
import SaveImageFromClipboard from "./save-image-from-clipboard";
import TikzEdit, { type TikzEditOpenRequest, type TikzEditOutcome } from "./tikz-edit";
import TikzRender from "./tikz-render";
import TutorialOpen from "./tutorial-open";
import UpdateProjectProperties from "./update-project-properties";
import UpdateUserDictionary from "./update-user-dictionary";
import WorkspaceSort from "./ws-sort";
import type { CommandWireValue, DispatchedCommand } from "./zettlr-command";

export const commands = [
  DirBindQuartoManifest,
  DirDelete,
  DirNewProject,
  DirNew,
  DirProjectExport,
  DirRemoveProject,
  DirRename,
  DirRescan,
  DirSettings,
  Export,
  FetchLinkPreview,
  FileDelete,
  FileDuplicate,
  FileNew,
  FileRename,
  FixAll,
  FileFindAndReturnMetaData,
  ForceOpen,
  ImportFiles,
  ImportLangFile,
  IncreasePomodoro,
  AddLanguageToolIgnoreRule,
  RunExternalLinter,
  OpenAttachment,
  OpenAuxWindow,
  Print,
  QuartoBookEditCommand,
  RenameReference,
  RenameTag,
  FormatDocument,
  RequestMove,
  RootClose,
  RootOpen,
  SaveImageFromClipboard,
  TikzEdit,
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
  "list-workspace-lint": {
    request: { payload: ListProblemsRequest };
    response: WorkspaceProblems;
  };
  "apply-lint-fix": {
    request: { payload: ApplyProblemFixRequest };
    response: FixAllOutcome;
  };
  "add-language-tool-ignore-rule": {
    request: { payload: LanguageToolIgnoredRuleEntry };
    response: unknown;
  };
  "commit-reference-rename": {
    request: { payload: { edit: WorkspaceReferenceEdit } };
    response: CommitRenameOutcome;
  };
  "commit-fix-all": {
    request: { payload: { plan: FixAllPlan } };
    response: FixAllOutcome;
  };
  "custom-export": {
    request: { payload: CustomExportIPCAPI };
    response: unknown;
  };
  "dir-bind-quarto-manifest": {
    request: { payload: DirBindQuartoManifestAPI };
    response: DirBindQuartoManifestOutcome;
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
  "rescan-dir": {
    request: { payload: { path: string } };
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
    request: { payload: FindFileAndReturnMetadataRequest };
    response: FindFileAndReturnMetadataResult;
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
    response: string | undefined;
  };
  "file-rename": {
    request: { payload: { path: string; name: string } };
    response: unknown;
  };
  "force-open": {
    request: { payload: ForceOpenAPI };
    response: unknown;
  };
  "format-document": {
    request: { payload: FormatDocumentRequest };
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
  // Answered inline by run(): documents.readDocumentText(), Promise<string>.
  "get-document-text": {
    request: { payload: string };
    response: string;
  };
  // Answered inline by run(): the citation database of the document at the
  // path, from its buffer text or its file (`documentBibliography`), after
  // the reads of its libraries ended.
  "get-document-bibliography": {
    request: { payload: string };
    response: CitationDatabase;
  };
  // Answered inline by run(): the cross-reference system that renders the
  // document at the path (`documentCrossReferenceSystem`).
  "get-cross-reference-system": {
    request: { payload: string };
    response: CrossReferenceSystem;
  };
  "open-attachment": {
    request: { payload: { citekey: string; filePath: string } };
    response: unknown;
  };
  // Answered inline by run(): the clipboard takes the image of the file that
  // the URI names. A file that is no image rejects.
  "copy-img-to-clipboard": {
    request: { payload: string };
    response: void;
  };
  // Answered inline by run(): the desktop opens the path with the
  // application of its type (`openPath`). A refusal rejects.
  "open-desktop-path": {
    request: { payload: string };
    response: void;
  };
  "edit-text-file": {
    request: { payload: string };
    response: string;
  };
  "list-justfile-commands": {
    request: { payload: string[] };
    response: JustfileListing;
  };
  // Answered inline by run(): the recently opened and recently edited files.
  "list-recent-files": {
    request: { payload?: undefined };
    response: RecentFiles;
  };
  "open-aux-window": {
    request: { payload: { window: ProgrammaticallyOpenableWindows; hash?: string } };
    response: unknown;
  };
  // Answered inline by run(): opens the file filter dialog in the last
  // active main window, the one editor of the ignore rules.
  "edit-ignore-rules": {
    request: { payload?: undefined };
    response: boolean;
  };
  // Answered inline by run(): shows the window, then returns true.
  "open-preferences": {
    request: { payload?: PreferenceNavigationTarget };
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
  // Answered inline by run(): launches the laptop's configured terminal
  // program for this integration and reports an empty string on success.
  "open-terminal-here": {
    request: { payload: string };
    response: string;
  };
  "run-just-recipe": {
    request: { payload: RunJustRecipeRequest };
    response: string;
  };
  // Answered inline by run(): shows the window and falls through without
  // returning, so invoke() resolves to undefined.
  "open-update-window": {
    request: { payload?: undefined };
    response: undefined;
  };
  "preview-fix-all": {
    request: { payload: FixAllRequest };
    response: FixAllPlan;
  };
  "preview-reference-rename": {
    request: { payload: { oldKey: string; newKey: string } };
    response: ReferenceRenamePreview;
  };
  print: {
    request: { payload?: string };
    response: unknown;
  };
  "quarto-book-edit": {
    request: { payload: QuartoBookEditRequest };
    response: ProjectSettings;
  };
  "rename-tag": {
    request: { payload: { oldName: string; newName: string } };
    response: unknown;
  };
  "request-move": {
    request: { payload: { from: string; to: string } };
    response: unknown;
  };
  "retry-workspace-lint": {
    request: { payload?: undefined };
    response: undefined;
  };
  "root-close": {
    request: { payload: string[] };
    response: boolean;
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
  "run-external-linter": {
    request: { payload: ExternalLinterRunRequest };
    response: ExternalLinterRunResponse;
  };
  "save-image-from-clipboard": {
    request: { payload: SaveImageFromClipboardAPI };
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
  "tikz-edit-close": {
    request: { payload: string };
    response: undefined;
  };
  "tikz-edit-open": {
    request: { payload: TikzEditOpenRequest };
    response: TikzEditOutcome;
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

/**
 * Commands that a window runs on its own, not on an action of the author: a
 * lint pass, a figure render, a hover preview, a refresh of the Problems view.
 * The caller shows a failure of these in its own place (the tooltip, the
 * figure, the view). A message in the window for each one would repeat with
 * each keystroke or pointer move. The preview of a reference rename is here
 * because its one caller shows each failure of the rename protocol.
 */
const CALLER_SHOWS_FAILURE: ReadonlySet<string> = new Set([
  "fetch-link-preview",
  "file-find-and-return-meta-data",
  "list-workspace-lint",
  "preview-reference-rename",
  "run-external-linter",
  "tikz-render",
]);

export default class CommandProvider extends ProviderContract {
  private readonly _commands: DispatchedCommand[];
  /** The errors that a window already shows: a command can run a command. */
  private readonly _shownFailures = new WeakSet<Error>();
  /**
   * The window whose renderer started the command that runs. A command that
   * a command runs has the window of the first one.
   */
  private readonly _startedBy = new AsyncLocalStorage<WebContents>();

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
        return await this._startedBy.run(event.sender, () => this.run(command, payload));
      } else {
        throw new Error(`[Commands] Could not run command "${String(command)}": Not a string`);
      }
    });
  }

  /**
   * Runs a command through the application pipeline. A command that throws
   * rejects: its caller receives the value of the contract or the error, never
   * a substitute. Most callers only log a rejection, so one window shows the
   * cause of each failure once.
   *
   * @param   {string}  command  The command to run
   * @param   {CommandWireValue}  payload  The payload the command requires
   *
   * @return  {Promise<CommandWireValue>}  The return from running the command
   */
  async run(command: string, payload: CommandWireValue): Promise<CommandWireValue> {
    try {
      return await this._dispatch(command, payload);
    } catch (err: unknown) {
      const failure = err instanceof Error ? err : new Error(String(err));
      if (!this._shownFailures.has(failure)) {
        this._shownFailures.add(failure);
        this._app.log.error(`[Application] The command ${command} failed: ${failure.message}`, err);
        if (!CALLER_SHOWS_FAILURE.has(command)) {
          this._showFailure({ command, message: failure.message });
        }
      }
      throw failure;
    }
  }

  /**
   * Sends a failure to the one window that shows it: the window that started
   * the command. The main window shows the failure of a command that the
   * application started (a menu item, a second instance) and of a command
   * whose window is gone.
   */
  private _showFailure(failure: CommandFailedBroadcast): void {
    const candidates = [
      this._startedBy.getStore(),
      this._app.windows.getFirstMainWindow()?.webContents,
    ];
    const window = candidates.find(
      (candidate) => candidate !== undefined && !candidate.isDestroyed() && !candidate.isCrashed(),
    );
    if (window === undefined) {
      return;
    }
    window.send(COMMAND_FAILED_CHANNEL, failure);
  }

  private async _dispatch(command: string, payload: CommandWireValue): Promise<CommandWireValue> {
    // FIRST: Try to run a minimal command for which its own custom function
    // wouldn't make sense.
    if (command === "copy-img-to-clipboard" && typeof payload === "string") {
      // The payload is the URI of the image file.
      const imagePath = filePathOfUri(payload);
      const image = nativeImage.createFromPath(imagePath);
      // Electron gives an empty image for a file that it cannot read or decode.
      if (image.isEmpty()) {
        throw new Error(trans("%s is not an image that can be copied.", imagePath));
      }
      clipboard.writeImage(image);
      return;
    } else if (command === "get-document-text" && typeof payload === "string") {
      return await this._app.documents.readDocumentText(payload);
    } else if (command === "get-document-bibliography" && typeof payload === "string") {
      const text = await this._app.documents.readDocumentText(payload);
      const { database } = await documentBibliography(this._app.fsal, payload, text);
      // The answer comes after the reads of its libraries, so a window that
      // renders the citations once renders them from the loaded libraries.
      await this._app.citeproc.loadDatabases(database);
      return database;
    } else if (command === "get-cross-reference-system" && typeof payload === "string") {
      return await documentCrossReferenceSystem(this._app.fsal, payload);
    } else if (command === "edit-ignore-rules") {
      const mainWindow = this._app.windows.getFirstMainWindow();
      if (mainWindow === undefined) {
        throw new Error("The file filter dialog has no main window to open in.");
      }
      mainWindow.show();
      mainWindow.webContents.send("shortcut", "edit-ignore-rules");
      return true;
    } else if (command === "open-preferences") {
      this._app.windows.showPreferences(payload as PreferenceNavigationTarget | undefined);
      return true;
    } else if (command === "open-desktop-path" && typeof payload === "string") {
      await openPath(payload);
      return;
    } else if (command === "edit-text-file" && typeof payload === "string") {
      return await launchKitty(path.dirname(payload), ["nvim", payload]);
    } else if (
      command === "list-justfile-commands" &&
      Array.isArray(payload) &&
      payload.every((root) => typeof root === "string")
    ) {
      const listing = await discoverJustfileCommands(payload);
      for (const { repoRoot, cause } of listing.notListed) {
        this._app.log.warning(`[Justfile commands] No recipes of ${repoRoot}: ${cause}`);
      }
      return listing;
    } else if (command === "list-recent-files") {
      return {
        opened: this._app.recentDocs.get(),
        edited: this._app.recentDocs.getEdited(),
      } satisfies RecentFiles;
    } else if (command === "open-terminal-here" && typeof payload === "string") {
      return await launchKitty(payload);
    } else if (
      command === "run-just-recipe" &&
      typeof payload === "object" &&
      payload !== null &&
      "repoRoot" in payload &&
      typeof payload.repoRoot === "string" &&
      "recipe" in payload &&
      typeof payload.recipe === "string" &&
      "args" in payload &&
      Array.isArray(payload.args) &&
      payload.args.every((arg) => typeof arg === "string")
    ) {
      return await launchKitty(
        payload.repoRoot,
        justRecipeCommand(payload.repoRoot, payload.recipe, payload.args),
      );
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
      const cmd = this._commands.find((elem) => elem.respondsTo(command));
      if (cmd !== undefined) {
        // Return the return value of the command, if there is any
        return await cmd.run(command, payload);
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
    await Promise.all(this._commands.map(async (command) => await command.shutdown()));
  }
}
