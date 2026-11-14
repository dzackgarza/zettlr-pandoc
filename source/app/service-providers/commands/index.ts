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
  IssuedReferenceRenamePreview,
  UndoRenameOutcome,
} from "@common/pandoc-util/compute-reference-edits";
import { sendIPCMessage } from "@common/util/broadcast-ipc-message";
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
import type { CrossReferenceSystem } from "@dts/common/references";
import type { TexCommandVocabulary } from "@dts/common/tex-vocabulary";
import {
  WORKSPACE_EDIT_PROPOSAL_CHANNEL,
  type WorkspaceEditProposal,
} from "@dts/common/workspace-edit";
import type { TikzRenderRequest, TikzRenderResult } from "@dzack/tikz-render/tikz-render";
import ProviderContract, { type IPCMessage } from "@providers/provider-contract";
import { clipboard, ipcMain, nativeImage, type WebContents } from "electron";
import { type AppServiceContainer } from "source/app/app-service-container";
import {
  documentBibliography,
  documentCrossReferenceSystem,
} from "source/app/util/document-bibliographies";
import { filePathOfUri } from "source/app/util/file-uri-path";
import { type Answer, type InvokeMessage } from "source/app/util/handle-ipc-channel";
import { discoverJustfileCommands } from "source/app/util/justfile-commands";
import { justRecipeCommand, launchKitty } from "source/app/util/kitty-launch";
import { openPath, revealPath } from "source/app/util/open-path";
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
import WorkspaceEditCommand from "./workspace-edit";
import WorkspaceSort from "./ws-sort";
import type ZettlrCommand from "./zettlr-command";

/**
 * The wire contract of the 'application' ipc channel: every command that
 * CommandProvider.run() runs, with its payload and the response that running
 * it resolves to. This map is the single owner of the channel's request AND
 * response shape. The renderer's invoke type is composed from it, and the
 * handler map of CommandProvider (`ApplicationHandlers`) has one handler for
 * each command, so a wrong command, payload or response fails to compile at
 * the call site and at the handler. A new command goes here and into the
 * handler map.
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
  // Applies the proposal that the main process sent to the window
  // (`CommandProvider.propose`), and answers true when each document has
  // the edit on disk. A conflict, a failed write and a refused save reject.
  "apply-workspace-edit": {
    request: { payload: { id: string } };
    response: boolean;
  };
  // Drops a proposal that the author did not apply.
  "discard-workspace-edit": {
    request: { payload: { id: string } };
    response: undefined;
  };
  // False when the rule was ignored before.
  "add-language-tool-ignore-rule": {
    request: { payload: LanguageToolIgnoredRuleEntry };
    response: boolean;
  };
  // Counts one more finished pomodoro in the statistics.
  "add-pomodoro": {
    request: { payload?: undefined };
    response: undefined;
  };
  "commit-reference-rename": {
    request: { payload: { id: string } };
    response: CommitRenameOutcome;
  };
  "commit-fix-all": {
    request: { payload: { plan: FixAllPlan } };
    response: FixAllOutcome;
  };
  "custom-export": {
    request: { payload: CustomExportIPCAPI };
    response: undefined;
  };
  "dir-bind-quarto-manifest": {
    request: { payload: DirBindQuartoManifestAPI };
    response: DirBindQuartoManifestOutcome;
  };
  // False when the author did not confirm or a document stayed open.
  "dir-delete": {
    request: { payload: { path: string } };
    response: boolean;
  };
  "dir-new": {
    request: { payload: { path: string; name?: string } };
    response: boolean;
  };
  "dir-new-project": {
    request: { payload: { path: string } };
    response: undefined;
  };
  // False when a profile did not export; an error window names each cause.
  "dir-project-export": {
    request: { payload: string };
    response: boolean;
  };
  "dir-remove-project": {
    request: { payload: { path: string } };
    response: undefined;
  };
  "dir-rename": {
    request: { payload: { path: string; name: string } };
    response: boolean;
  };
  "rescan-dir": {
    request: { payload: { path: string } };
    response: undefined;
  };
  export: {
    request: { payload: ExportIPCAPI };
    response: undefined;
  };
  "fetch-link-preview": {
    request: { payload: string };
    response: LinkPreviewResult | undefined;
  };
  "file-find-and-return-meta-data": {
    request: { payload: FindFileAndReturnMetadataRequest };
    response: FindFileAndReturnMetadataResult;
  };
  // False when the author did not confirm or the document stayed open.
  "file-delete": {
    request: { payload: { path: string } };
    response: boolean;
  };
  "file-duplicate": {
    request: { payload: { path: string; windowId: string; leafId?: string; name?: string } };
    response: undefined;
  };
  "file-new": {
    request: {
      payload: {
        path?: string;
        name?: string;
        type?: DocumentType;
        windowId?: string;
        leafId?: string;
      };
    };
    response: string | undefined;
  };
  "file-rename": {
    request: { payload: { path: string; name: string } };
    response: undefined;
  };
  "force-open": {
    request: { payload: ForceOpenAPI };
    response: undefined;
  };
  "format-document": {
    request: { payload: FormatDocumentRequest };
    response: FormatResult;
  };
  // Answered in the handler map: enumDictFiles().map(elem => elem.tag).
  "get-available-dictionaries": {
    request: { payload?: undefined };
    response: string[];
  };
  // Answered in the handler map: enumLangFiles().map(elem => elem.tag).
  "get-available-languages": {
    request: { payload?: undefined };
    response: string[];
  };
  // Answered in the handler map: documents.readDocumentText(), Promise<string>.
  "get-document-text": {
    request: { payload: string };
    response: string;
  };
  // Answered in the handler map: the citation database of the document at the
  // path, from its buffer text or its file (`documentBibliography`), after
  // the reads of its libraries ended.
  "get-document-bibliography": {
    request: { payload: string };
    response: CitationDatabase;
  };
  // Answered in the handler map: the cross-reference system that renders the
  // document at the path (`documentCrossReferenceSystem`).
  "get-cross-reference-system": {
    request: { payload: string };
    response: CrossReferenceSystem;
  };
  // Answered in the handler map: Flowmark's TeXstudio command index and the
  // packages that the `tex` lint context loads (`readTexCommandVocabulary`).
  "tex-command-vocabulary": {
    request: { payload?: undefined };
    response: TexCommandVocabulary;
  };
  "open-attachment": {
    request: { payload: { citekey: string; filePath: string } };
    response: boolean;
  };
  // Answered in the handler map: the clipboard takes the image of the file that
  // the URI names. A file that is no image rejects.
  "copy-img-to-clipboard": {
    request: { payload: string };
    response: void;
  };
  // Answered in the handler map: the desktop opens the path with the
  // application of its type (`openPath`). A refusal rejects.
  "open-desktop-path": {
    request: { payload: string };
    response: void;
  };
  // Answered in the handler map: the desktop shows a folder, or the folder of a
  // file, in its file browser (`revealPath`). A refusal rejects.
  "reveal-path": {
    request: { payload: { path: string } | { uri: string } };
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
  // Answered in the handler map: the recently opened and recently edited files.
  "list-recent-files": {
    request: { payload?: undefined };
    response: RecentFiles;
  };
  "open-aux-window": {
    request: { payload: { window: ProgrammaticallyOpenableWindows; hash?: string } };
    response: boolean;
  };
  // Answered in the handler map: opens the file filter dialog in the last
  // active main window, the one editor of the ignore rules.
  "edit-ignore-rules": {
    request: { payload?: undefined };
    response: boolean;
  };
  // Answered in the handler map: shows the window, then returns true.
  "open-preferences": {
    request: { payload?: PreferenceNavigationTarget };
    response: boolean;
  };
  // Answered in the handler map: shows the window and falls through without
  // returning, so invoke() resolves to undefined.
  "open-project-preferences": {
    request: { payload: string };
    response: undefined;
  };
  // Answered in the handler map: shows the window, then returns true.
  "open-stats-window": {
    request: { payload?: undefined };
    response: boolean;
  };
  // Answered in the handler map: launches the laptop's configured terminal
  // program for this integration and reports an empty string on success.
  "open-terminal-here": {
    request: { payload: string };
    response: string;
  };
  "run-just-recipe": {
    request: { payload: RunJustRecipeRequest };
    response: string;
  };
  // Answered in the handler map: shows the window and falls through without
  // returning, so invoke() resolves to undefined.
  "open-update-window": {
    request: { payload?: undefined };
    response: undefined;
  };
  "tutorial-open": {
    request: { payload?: undefined };
    response: undefined;
  };
  "import-files": {
    request: { payload?: undefined };
    response: boolean;
  };
  "import-lang-file": {
    request: { payload?: undefined };
    response: boolean;
  };
  "preview-fix-all": {
    request: { payload: FixAllRequest };
    response: FixAllPlan;
  };
  "preview-reference-rename": {
    request: { payload: { oldKey: string; newKey: string } };
    response: IssuedReferenceRenamePreview;
  };
  print: {
    request: { payload?: string };
    response: undefined;
  };
  "quarto-book-edit": {
    request: { payload: QuartoBookEditRequest };
    response: ProjectSettings;
  };
  // True when a file has the tag; the window then shows the edit.
  "rename-tag": {
    request: { payload: { oldName: string; newName: string } };
    response: boolean;
  };
  "request-move": {
    request: { payload: { from: string; to: string } };
    response: boolean;
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
    response: boolean;
  };
  "root-open-files": {
    request: { payload?: undefined };
    response: boolean;
  };
  "roots-add": {
    request: { payload: string[] };
    response: boolean;
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
    response: boolean;
  };
  "sort-workspaces": {
    request: { payload: string[] };
    response: boolean;
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
    response: undefined;
  };
  // Replaces the words of the user dictionary; false for a payload that is no list.
  "update-user-dictionary": {
    request: { payload: string[] };
    response: boolean;
  };
};

export type ApplicationIPCAPI = IPCMessage<ApplicationIPCContract>;

/** A command that a caller runs through `CommandProvider.run`. */
export type ApplicationCommand = keyof ApplicationIPCContract;

/**
 * The payload of a command, as the contract states it. The handler of the
 * command takes this type, so the contract, the callers and the handler
 * cannot name different fields.
 */
export type ApplicationPayload<K extends ApplicationCommand> =
  ApplicationIPCContract[K]["request"]["payload"];

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

/** The response that the contract declares for a command. */
export type ApplicationResponse<K extends ApplicationCommand> =
  ApplicationIPCContract[K]["response"];

/** What the handler of a command answers: the response of the contract. */
export type ApplicationAnswer<K extends ApplicationCommand> = Answer<ApplicationResponse<K>>;

/**
 * The handlers of the `application` channel: one for each command of the
 * contract. A map without a command of the contract, with a command that the
 * contract does not name, or with a handler whose answer is not the response
 * of its command does not compile.
 */
export type ApplicationHandlers = {
  [K in ApplicationCommand]: (
    payload: ApplicationPayload<K>,
  ) => ApplicationAnswer<K> | Promise<ApplicationAnswer<K>>;
};

export default class CommandProvider extends ProviderContract {
  /** The handler of each command of the contract. */
  private readonly _handlers: ApplicationHandlers;
  /** The commands that the provider made; each one stops at the shutdown. */
  private readonly _commands: Array<Pick<ZettlrCommand, "shutdown">>;
  /** The errors that a window already shows: a command can run a command. */
  private readonly _shownFailures = new WeakSet<Error>();
  /**
   * The window whose renderer started the command that runs. A command that
   * a command runs has the window of the first one.
   */
  private readonly _startedBy = new AsyncLocalStorage<WebContents>();
  /** The proposals that wait for the author, by id. */
  private readonly _proposals = new Map<string, WorkspaceEditProposal>();

  // TODO: Right now this just injects the full service container into the
  // commands, but it mayt be better to only provide those which are actually
  // required.
  constructor(private readonly _app: AppServiceContainer) {
    super();
    const addLanguageToolIgnoreRule = new AddLanguageToolIgnoreRule(_app);
    const dirBindQuartoManifest = new DirBindQuartoManifest(_app);
    const dirDelete = new DirDelete(_app);
    const dirNew = new DirNew(_app);
    const dirNewProject = new DirNewProject(_app);
    const dirProjectExport = new DirProjectExport(_app);
    const dirRemoveProject = new DirRemoveProject(_app);
    const dirRename = new DirRename(_app);
    const dirRescan = new DirRescan(_app);
    const dirSettings = new DirSettings(_app);
    const exporter = new Export(_app);
    const fetchLinkPreview = new FetchLinkPreview(_app);
    const fileDelete = new FileDelete(_app);
    const fileDuplicate = new FileDuplicate(_app);
    const fileFindAndReturnMetaData = new FileFindAndReturnMetaData(_app);
    const fileNew = new FileNew(_app);
    const fileRename = new FileRename(_app);
    const fixAll = new FixAll(_app);
    const forceOpen = new ForceOpen(_app);
    const formatDocument = new FormatDocument(_app);
    const importFiles = new ImportFiles(_app);
    const importLangFile = new ImportLangFile(_app);
    const increasePomodoro = new IncreasePomodoro(_app);
    const openAttachment = new OpenAttachment(_app);
    const openAuxWindow = new OpenAuxWindow(_app);
    const print = new Print(_app);
    const quartoBookEdit = new QuartoBookEditCommand(_app);
    const renameReference = new RenameReference(_app);
    const renameTag = new RenameTag(_app);
    const requestMove = new RequestMove(_app);
    const rootClose = new RootClose(_app);
    const rootOpen = new RootOpen(_app);
    const runExternalLinter = new RunExternalLinter(_app);
    const saveImageFromClipboard = new SaveImageFromClipboard(_app);
    const tikzEdit = new TikzEdit(_app);
    const tikzRender = new TikzRender(_app);
    const tutorialOpen = new TutorialOpen(_app);
    const updateProjectProperties = new UpdateProjectProperties(_app);
    const updateUserDictionary = new UpdateUserDictionary(_app);
    const workspaceEdit = new WorkspaceEditCommand(_app);
    const workspaceSort = new WorkspaceSort(_app);

    this._commands = [
      addLanguageToolIgnoreRule,
      dirBindQuartoManifest,
      dirDelete,
      dirNew,
      dirNewProject,
      dirProjectExport,
      dirRemoveProject,
      dirRename,
      dirRescan,
      dirSettings,
      exporter,
      fetchLinkPreview,
      fileDelete,
      fileDuplicate,
      fileFindAndReturnMetaData,
      fileNew,
      fileRename,
      fixAll,
      forceOpen,
      formatDocument,
      importFiles,
      importLangFile,
      increasePomodoro,
      openAttachment,
      openAuxWindow,
      print,
      quartoBookEdit,
      renameReference,
      renameTag,
      requestMove,
      rootClose,
      rootOpen,
      runExternalLinter,
      saveImageFromClipboard,
      tikzEdit,
      tikzRender,
      tutorialOpen,
      updateProjectProperties,
      updateUserDictionary,
      workspaceEdit,
      workspaceSort,
    ];

    this._handlers = {
      "add-language-tool-ignore-rule": async (payload) =>
        await addLanguageToolIgnoreRule.run("add-language-tool-ignore-rule", payload),
      "add-pomodoro": async () => {
        await increasePomodoro.run("add-pomodoro", undefined);
      },
      "apply-lint-fix": async (payload) => await fixAll.applyProblemFix(payload),
      "apply-workspace-edit": async ({ id }) => await workspaceEdit.apply(id),
      "commit-fix-all": async ({ plan }) => await fixAll.commit(plan),
      "commit-reference-rename": async (payload) => await renameReference.commit(payload),
      "copy-img-to-clipboard": (uri) => {
        const imagePath = filePathOfUri(uri);
        const image = nativeImage.createFromPath(imagePath);
        // Electron gives an empty image for a file that it cannot read or decode.
        if (image.isEmpty()) {
          throw new Error(trans("%s is not an image that can be copied.", imagePath));
        }
        clipboard.writeImage(image);
      },
      "custom-export": async (payload) => {
        await exporter.run("custom-export", payload);
      },
      "dir-bind-quarto-manifest": async (payload) =>
        await dirBindQuartoManifest.run("dir-bind-quarto-manifest", payload),
      "dir-delete": async (payload) => await dirDelete.run("dir-delete", payload),
      "dir-new": async (payload) => await dirNew.run("dir-new", payload),
      "dir-new-project": async (payload) => {
        await dirNewProject.run("dir-new-project", payload);
      },
      "dir-project-export": async (payload) =>
        await dirProjectExport.run("dir-project-export", payload),
      "dir-remove-project": async (payload) => {
        await dirRemoveProject.run("dir-remove-project", payload);
      },
      "dir-rename": async (payload) => await dirRename.run("dir-rename", payload),
      "discard-workspace-edit": ({ id }) => {
        workspaceEdit.discard(id);
      },
      "edit-ignore-rules": () => {
        const mainWindow = this._app.windows.getFirstMainWindow();
        if (mainWindow === undefined) {
          throw new Error("The file filter dialog has no main window to open in.");
        }
        mainWindow.show();
        sendIPCMessage(mainWindow.webContents, "shortcut", "edit-ignore-rules");
        return true;
      },
      "edit-text-file": async (filePath) =>
        await launchKitty(path.dirname(filePath), ["nvim", filePath]),
      export: async (payload) => {
        await exporter.run("export", payload);
      },
      "fetch-link-preview": async (url) => await fetchLinkPreview.run("fetch-link-preview", url),
      "file-delete": async (payload) => await fileDelete.run("file-delete", payload),
      "file-duplicate": async (payload) => {
        await fileDuplicate.run("file-duplicate", payload);
      },
      "file-find-and-return-meta-data": async (payload) =>
        await fileFindAndReturnMetaData.run("file-find-and-return-meta-data", payload),
      "file-new": async (payload) => await fileNew.run("file-new", payload),
      "file-rename": async (payload) => {
        await fileRename.run("file-rename", payload);
      },
      "force-open": async (payload) => {
        await forceOpen.run("force-open", payload);
      },
      "format-document": async (payload) => await formatDocument.run("format-document", payload),
      "get-available-dictionaries": () => enumDictFiles().map((elem) => elem.tag),
      "get-available-languages": () => enumLangFiles().map((elem) => elem.tag),
      "get-cross-reference-system": async (filePath) =>
        await documentCrossReferenceSystem(this._app.fsal, filePath),
      "get-document-bibliography": async (filePath) => {
        const text = await this._app.documents.readDocumentText(filePath);
        const { database } = await documentBibliography(this._app.fsal, filePath, text);
        // The answer comes after the reads of its libraries, so a window that
        // renders the citations once renders them from the loaded libraries.
        await this._app.citeproc.loadDatabases(database);
        return database;
      },
      "get-document-text": async (filePath) => await this._app.documents.readDocumentText(filePath),
      "import-files": async () => await importFiles.run("import-files", undefined),
      "import-lang-file": async () => await importLangFile.run("import-lang-file", undefined),
      "list-justfile-commands": async (repoRoots) => {
        const listing = await discoverJustfileCommands(repoRoots);
        for (const { repoRoot, cause } of listing.notListed) {
          this._app.log.warning(`[Justfile commands] No recipes of ${repoRoot}: ${cause}`);
        }
        return listing;
      },
      "list-recent-files": () => ({
        opened: this._app.recentDocs.get(),
        edited: this._app.recentDocs.getEdited(),
      }),
      "list-workspace-lint": async (payload) => await fixAll.listProblems(payload),
      "open-attachment": async (payload) => await openAttachment.run("open-attachment", payload),
      "open-aux-window": async (payload) => await openAuxWindow.run("open-aux-window", payload),
      "open-desktop-path": async (filePath) => {
        await openPath(filePath);
      },
      "open-preferences": (target) => {
        this._app.windows.showPreferences(target);
        return true;
      },
      "open-project-preferences": (dirPath) => {
        this._app.windows.showProjectPropertiesWindow(dirPath);
      },
      "open-stats-window": () => {
        this._app.windows.showStatsWindow();
        return true;
      },
      "open-terminal-here": async (directory) => await launchKitty(directory),
      "open-update-window": () => {
        this._app.windows.showUpdateWindow();
      },
      "preview-fix-all": async (payload) => await fixAll.preview(payload),
      "preview-reference-rename": async (payload) => await renameReference.preview(payload),
      print: async (filePath) => {
        await print.run("print", filePath);
      },
      "quarto-book-edit": async (payload) => await quartoBookEdit.run("quarto-book-edit", payload),
      "rename-tag": async (payload) => await renameTag.run("rename-tag", payload),
      "request-move": async (payload) => await requestMove.run("request-move", payload),
      "rescan-dir": async (payload) => {
        await dirRescan.run("rescan-dir", payload);
      },
      "retry-workspace-lint": async () => {
        await fixAll.retry();
      },
      "reveal-path": async (target) => {
        await revealPath("path" in target ? target.path : filePathOfUri(target.uri));
      },
      "root-close": async (roots) => await rootClose.run("root-close", roots),
      "root-open-files": async () => await rootOpen.run("root-open-files", []),
      "root-open-workspaces": async () => await rootOpen.run("root-open-workspaces", []),
      "roots-add": async (roots) => await rootOpen.run("roots-add", roots),
      "run-external-linter": async (request) =>
        await runExternalLinter.run("run-external-linter", request),
      "run-just-recipe": async ({ repoRoot, recipe, args }) =>
        await launchKitty(repoRoot, justRecipeCommand(repoRoot, recipe, args)),
      "save-image-from-clipboard": async (payload) =>
        await saveImageFromClipboard.run("save-image-from-clipboard", payload),
      "set-directory-setting": async (payload) =>
        await dirSettings.run("set-directory-setting", payload),
      "sort-workspaces": async (order) => await workspaceSort.run("sort-workspaces", order),
      "tex-command-vocabulary": async () => await this._app.documentLint.texCommandVocabulary(),
      "tikz-edit-close": (sessionId) => {
        tikzEdit.close(sessionId);
      },
      "tikz-edit-open": async (request) => await tikzEdit.open(request),
      "tikz-render": async (request) => await tikzRender.run("tikz-render", request),
      "tutorial-open": async () => {
        await tutorialOpen.run("tutorial-open", undefined);
      },
      "undo-reference-rename": async () => await renameReference.undo(),
      "update-project-properties": async (payload) => {
        await updateProjectProperties.run("update-project-properties", payload);
      },
      "update-user-dictionary": async (words) =>
        await updateUserDictionary.run("update-user-dictionary", words),
    };

    // Electron types the message of a window as `any`. The call of the
    // window is typed by the same contract (IpcInvoke), so the message is one
    // of the channel; `run` examines its command before a handler gets it.
    // The channel does not go through handleInvokeChannel: main-process code
    // runs the same handlers through `run`, without an IPC event.
    ipcMain.handle(
      "application",
      async (event, message: InvokeMessage<"application", ApplicationCommand>) => {
        if (typeof message !== "object" || message === null) {
          throw new Error("The channel application received a message without a command.");
        }
        return await this._startedBy.run(
          event.sender,
          async () => await this.run(message.command, message.payload),
        );
      },
    );
  }

  /**
   * Runs a command through the application pipeline. A command that throws
   * rejects: its caller receives the value of the contract or the error, never
   * a substitute. Most callers only log a rejection, so one window shows the
   * cause of each failure once. A command that the contract does not name
   * rejects with an error that names it.
   *
   * @param   {ApplicationCommand}  command  The command to run
   * @param   {ApplicationPayload}  payload  The payload of the contract
   *
   * @return  {Promise<ApplicationAnswer>}  The response of the contract
   */
  async run<K extends ApplicationCommand>(
    command: K,
    payload: ApplicationPayload<K>,
  ): Promise<ApplicationAnswer<K>> {
    try {
      if (!Object.hasOwn(this._handlers, command)) {
        throw new Error(`The channel application has no command ${String(command)}.`);
      }
      return await this._handlers[command](payload);
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
    const window = this._startingWindow();
    if (window !== undefined) {
      sendIPCMessage(window, COMMAND_FAILED_CHANNEL, failure);
    }
  }

  /**
   * The window that answers for the command that runs: the window that
   * started it, or the main window for a command that the application
   * started and for a command whose window is gone.
   */
  private _startingWindow(): WebContents | undefined {
    const candidates = [
      this._startedBy.getStore(),
      this._app.windows.getFirstMainWindow()?.webContents,
    ];
    return candidates.find(
      (candidate) => candidate !== undefined && !candidate.isDestroyed() && !candidate.isCrashed(),
    );
  }

  /**
   * Shows a proposal in the window that started the command that runs (see
   * `_startingWindow`). The proposal waits there until the author applies
   * or discards it (`takeProposal`); it goes away with its window. Nothing
   * changes before that.
   */
  propose(proposal: WorkspaceEditProposal): void {
    const window = this._startingWindow();
    if (window === undefined) {
      throw new Error(trans("No window can show the edit: %s", proposal.description));
    }
    this._proposals.set(proposal.id, proposal);
    window.once("destroyed", () => this._proposals.delete(proposal.id));
    sendIPCMessage(window, WORKSPACE_EDIT_PROPOSAL_CHANNEL, proposal);
  }

  /** The proposal with the id, which no other call can take after this one. */
  takeProposal(id: string): WorkspaceEditProposal {
    const proposal = this._proposals.get(id);
    if (proposal === undefined) {
      throw new Error(trans("The edit is no longer available. No file changed."));
    }
    this._proposals.delete(id);
    return proposal;
  }

  async shutdown(): Promise<void> {
    this._app.log.verbose("Command Provider shutting down ...");
    await Promise.all(this._commands.map(async (command) => await command.shutdown()));
  }
}
