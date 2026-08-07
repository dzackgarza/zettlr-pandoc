/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        MarkdownEditor class
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This module contains the functionality to spin up a fully
 *                  functioning CodeMirror editor containing all the additional
 *                  API calls and hooks that Zettlr makes use of for its
 *                  powerful internal editor. The class's API provides a
 *                  multitude of options to tweak the editor to the specific
 *                  needs of different environments.
 *
 * END HEADER
 */

// Import our additional styles we need to put here since we don't have a Vue
// component for the editor itself.
import "./editor.css";

import { foldEffect, foldState, syntaxTree } from "@codemirror/language";
import { closeSearchPanel, openSearchPanel, searchPanelOpen } from "@codemirror/search";
import {
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  type SelectionRange,
  type StateEffect,
  Text,
} from "@codemirror/state";
// CodeMirror imports
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { countAll } from "@common/util/counter";
import safeAssign from "@common/util/safe-assign";
import { DocumentType } from "@dts/common/documents";
import {
  type DocumentLocation,
  type ReferenceCompletionEntry,
  type SourceRange,
} from "@dts/common/references";
import type { ReviewDiffSession } from "@dts/common/review-diff";

/**
 * What the pane must do with a review decision. Every method carries the
 * review generation the widgets were drawn from; the implementation adds the
 * hash of the text they were drawn over, and main refuses anything that no
 * longer matches. A method rejects when the mutation was refused.
 */
export interface ReviewActionClient {
  decide: (input: {
    reviewId: string;
    expectedReviewGeneration: number;
    chunkId: string;
    decision: "accept" | "reject";
  }) => Promise<void>;
  acceptAll: (input: {
    reviewId: string;
    expectedReviewGeneration: number;
  }) => Promise<void>;
  clear: (input: { reviewId: string; expectedReviewGeneration: number }) => Promise<void>;
  comment: (input: {
    reviewId: string;
    expectedReviewGeneration: number;
    text: string;
  }) => Promise<void>;
  commentChunk: (input: {
    reviewId: string;
    expectedReviewGeneration: number;
    chunkId: string;
    text: string;
  }) => Promise<void>;
}
import { type TagRecord } from "@providers/tags";
// Keymaps/Input modes
import { emacs } from "@replit/codemirror-emacs";
/**
 * APIs
 */
import EventEmitter from "events";
import { parsePandocAttributes } from "source/common/pandoc-util/parse-pandoc-attributes";
import { markdownToAST } from "../markdown-utils";
import type { ASTNode, Document as MarkdownDocument } from "../markdown-utils/markdown-ast";
import {
  citekeyUpdate,
  filesUpdate,
  referencesUpdate,
  snippetsUpdate,
  tagsUpdate,
} from "./autocomplete";
import { addNewFootnote } from "./commands/footnotes";
import {
  type FormatResult,
  formatDocument,
  type MarkdownFormatter,
} from "./commands/format-document";
// Custom commands
import {
  applyComment,
  applyPandocDivOrSpan,
  applyTaskList,
  insertImage,
  insertLink,
} from "./commands/markdown";
import { moveSection } from "./commands/move-section";
// Main configuration
import {
  type CoreExtensionOptions,
  getJSONExtensions,
  getMainEditorThemes,
  getMarkdownExtensions,
  getTexExtensions,
  getYAMLExtensions,
  inputModeCompartment,
} from "./editor-extension-sets";
import { clickListeners } from "./plugins/click-listeners";
import {
  createReferenceLabel,
  openCreateReferenceLabelEffect,
} from "./plugins/create-reference-label";
import { editorMetadataFacet } from "./plugins/editor-metadata";
import { formatDocumentEffect } from "./plugins/format-document-effect";
import { highlightRangesEffect } from "./plugins/highlight-ranges";
import { openPandocQuickHelpEffect } from "./plugins/pandoc-quick-help-effect";
import { type ProjectInfo, projectInfoUpdateEffect } from "./plugins/project-info-field";
import { openReferenceSearchEffect } from "./plugins/reference-search-effect";
import {
  type PullUpdateCallback,
  type PushUpdateCallback,
  reloadStateEffect,
} from "./plugins/remote-doc";
import { reviewChunksExtension } from "./plugins/review-chunks";
import { countField, updateWordCountEffect } from "./plugins/statistics-fields";
import { type ToCEntry, tocField } from "./plugins/toc-field";
import { vimPlugin } from "./plugins/vim-mode";
import {
  type EditorWorkspaceReferences,
  workspaceReferencesUpdate,
} from "./plugins/workspace-references-field";
import { darkModeEffect, useDarkModeEditor } from "./theme/dark-mode";
import {
  configField,
  configUpdateEffect,
  cloneEditorConfiguration,
  type EditorConfigOptions,
  type EditorConfiguration,
  getDefaultConfig,
} from "./util/configuration";
// Utilities
import { copyAsHTML, pasteAsPlain } from "./util/copy-paste-cut";
import { whenAuthoritySynced } from "./util/when-authority-synced";

export interface DocumentWrapper {
  path: string;
  state: EditorState;
  type: DocumentType;
}

/**
 * This is basically the old Codemirror 5 way of representing positions. While
 * Codemirror 6 is way more efficient describing everything as a string offset,
 * the line/ch representation makes a lot of sense for the users, so we keep
 * offering that here.
 */
export interface UserReadablePosition {
  line: number;
  ch: number;
}

export interface DocumentInfo {
  words: number;
  chars: number;
  cursor: UserReadablePosition;
  selections: Array<{
    anchor: UserReadablePosition;
    head: UserReadablePosition;
    words: number;
    chars: number;
  }>;
}

export type FetchDoc = (
  filePath: string,
) => Promise<{ content: string; type: DocumentType; startVersion: number }>;

/**
 * This interface is used to provide the editor with an API of where to fetch
 * the documents from. The remote could be, e.g., either behind a websocket or
 * an IPC bridge.
 */
export interface DocumentAuthorityAPI {
  /**
   * Used to fetch the document from the document authority
   */
  fetchDoc: FetchDoc;
  /**
   * Used to pull new updates from the document authority
   */
  pullUpdates: PullUpdateCallback;
  /**
   * Used to push updates to the document authority
   */
  pushUpdates: PushUpdateCallback;
}

/**
 * This interface describes a persistent state for the EditorView, meaning some
 * state that should survive destruction and re-instantiation of the same
 * EditorView. It holds information that should be restored during, e.g.,
 * switching tabs, which includes a scroll snapshot and the selection(s). By
 * passing this information to a new MarkdownEditor instance, the editor can
 * restore this quickly. The caller/manager of a set of MarkdownEditor instances
 * should keep track of these, and extract them from the MarkdownEditor instance
 * before unmounting it, e.g., via a Map.
 */
export interface EditorViewPersistentState {
  /**
   * A scroll snapshot from the editor. Used to properly restore the scroll
   * position.
   */
  scrollSnapshot: StateEffect<unknown>;
  /**
   * A selection object. Used to properly restore the cursor position and any
   * selections within the editor.
   */
  selection: EditorSelection;

  /**
   * A decoration set containing currently folded ranges.
   */
  foldedRanges: DecorationSet;
}

export default class MarkdownEditor extends EventEmitter {
  /**
   * The underlying CodeMirror view
   *
   * @var {EditorView}
   */
  private readonly _instance: EditorView;
  /**
   * The absolute path to the document represented by this MainEditor instance.
   *
   * @var {string}
   */
  private readonly representedDocument: string;
  /**
   * The API method used to synchronize the document with an authority.
   *
   * @var {DocumentAuthorityAPI}
   */
  private readonly authority: DocumentAuthorityAPI;
  /**
   * The full editor configuration
   *
   * @var {EditorConfiguration}
   */
  private config: EditorConfiguration;

  /**
   * Resolves when the initial document has been installed into CodeMirror.
   * Consumers must handle rejection and surface it to the user.
   */
  public readonly ready: Promise<void>;

  /**
   * The database cache for the various autocompletes.
   *
   * @var {any}
   */
  private readonly databaseCache: {
    tags: TagRecord[];
    citations: Array<{ citekey: string; displayText: string }>;
    snippets: Array<{ name: string; content: string }>;
    files: Array<{ filename: string; displayName: string; id: string }>;
    references: ReferenceCompletionEntry[];
  };

  /**
   * The last resolved workspace reference view pushed into this editor
   * (issue #1 Phase 4), re-dispatched whenever the state is rebuilt.
   *
   * @var {EditorWorkspaceReferences|null}
   */
  private workspaceReferencesCache: EditorWorkspaceReferences | null;

  private readonly reviewDiffCompartment: Compartment;

  /** Installed by the pane that owns this editor; see setReviewActionClient. */
  private reviewActionClient: ReviewActionClient | null = null;
  private activeReviewDiffSession: ReviewDiffSession | null;
  private pendingReviewDiffSession: ReviewDiffSession | null = null;

  /**
   * Creates a new MarkdownEditor instance associated with the given leafId and
   * the representedDocument. Immediately after instantiation the editor will
   * pull the document from the given authorityAPI and set it up.
   *
   * NOTE that you will have to append the resulting editor DOM element onto the
   * DOM tree yourself in order for the editor to actually show up. Example:
   *
   * ```ts
   * const editor = new MarkdownEditor(leafId, filePath, api)
   * const container = document.getElementById('container')
   * container.appendChild(editor.dom)
   * ```
   *
   * @param  {string}                leafId               The ID of the leaf
   *                                                      this editor is part of
   * @param  {string}                windowId             The window's ID
   * @param  {string}                representedDocument  The absolute path to
   *                                                      the file that will be
   *                                                      loaded in this editor
   * @param  {DocumentAuthorityAPI}  authorityAPI         The authority API this
   *                                                      editor should use.
   *                                                      Should normally be the
   *                                                      IPC authority.
   */
  constructor(
    readonly leafId: string,
    readonly windowId: string,
    representedDocument: string,
    authorityAPI: DocumentAuthorityAPI,
    configOverride?: Partial<EditorConfiguration>,
    persistentState?: EditorViewPersistentState,
  ) {
    super(); // Set up the event emitter

    this.authority = authorityAPI;
    this.representedDocument = representedDocument;

    // Since the editor state needs to be rebuilt from scratch sometimes, we
    // cache the autocomplete databases so that we don't have to re-fetch them
    // everytime.
    this.databaseCache = {
      tags: [],
      citations: [],
      snippets: [],
      files: [],
      references: [],
    };
    this.workspaceReferencesCache = null;
    this.reviewDiffCompartment = new Compartment();
    this.activeReviewDiffSession = null;

    // Same goes for the config
    this.config = getDefaultConfig();
    // TODO: This is bad style imho
    this.config.metadata.path = representedDocument;
    if (configOverride !== undefined) {
      this.setOptions(configOverride);
    }

    // Create the editor ...
    this._instance = new EditorView({
      state: undefined,
      parent: undefined,
    });

    // ... and immediately begin loading the document. The owning renderer
    // awaits this promise so initialization failures cannot disappear into a
    // console-only catch while an empty EditorView remains visible.
    this.ready = this.loadDocument(persistentState);
  }

  /**
   * Returns the correct set of extensions for the given document
   *
   * @param   {string}        filePath      The file path
   * @param   {DocumentType}  type          The type of file we're dealing with
   * @param   {number}        startVersion  The initial synchronization number
   *
   * @return  {Extension[]}                 The extension set
   */
  private _getExtensions(filePath: string, type: DocumentType, startVersion: number): Extension[] {
    const editorInstance = this;

    const options: CoreExtensionOptions = {
      initialConfig: cloneEditorConfiguration(this.config),
      remoteConfig: {
        filePath,
        startVersion,
        pullUpdates: this.authority.pullUpdates,
        pushUpdates: this.authority.pushUpdates,
      },
      updateListener: (update) => {
        // Listen for changes and emit events appropriately
        if (update.docChanged) {
          this.emit("change");
          queueMicrotask(() => this.activatePendingReviewDiffSession());
        }

        if (update.focusChanged && this._instance.hasFocus) {
          this.emit("focus");
        }

        if (update.selectionSet) {
          this.emit("cursorActivity");
          this.emit("docUpdate");
        }

        for (const transaction of update.transactions) {
          for (const effect of transaction.effects) {
            // Listen for word count updates
            if (effect.is(updateWordCountEffect)) {
              this.emit("docUpdate");
            }

            // Workspace reference search request — plain Mod-P (null) or a
            // count badge's keyed reverse lookup ({ key }): surface the
            // request payload to the shell (MainEditor.vue relays it up to
            // App.vue's overlay; dropping the payload here would break the
            // Phase 8 badge-keyed reverse lookup).
            if (effect.is(openReferenceSearchEffect)) {
              this.emit("reference-search", effect.value);
            }

            // Create-reference-label request (issue #1 Phase 6): surface
            // the typed request to the shell (MainEditor.vue relays it up
            // to App.vue's CreateReferenceLabelDialog mount).
            if (effect.is(openCreateReferenceLabelEffect)) {
              this.emit("create-reference-label", effect.value);
            }

            // Pandoc quick-help request (issue #1, review A2 / US-06): an
            // in-editor help link — the completion info panel — asked for
            // the searchable quick help; MainEditor.vue relays it up to
            // App.vue's PandocQuickHelp mount.
            if (effect.is(openPandocQuickHelpEffect)) {
              this.emit("pandoc-quick-help");
            }

            // A keystroke requested a flowmark format (issue #26). The actual
            // IPC format runs in the renderer (MainEditor.vue), which has
            // electron; the editor core only relays the request.
            if (effect.is(formatDocumentEffect)) {
              this.emit("format-document");
            }

            // Listen for config updates, and parse them into the internal cache. We
            // do it this way, because the editor itself is also capable of changing
            // its configuration (e.g., via the statusbar). This way we ensure that
            // both external updates (via setOptions) as well as internal updates
            // both end up in our cache.
            if (effect.is(reloadStateEffect)) {
              // ATTENTION: The document state is out of sync with the document
              // authority, so we must reload it.
              this.clearReviewDiffSession();
              this.reload().catch((error) =>
                this.emit("document-load-error", error),
              );
              return;
            }
          }
        }

      },
      domEventsListeners: clickListeners({
        onWikiLink(url) {
          editorInstance.emit("zettelkasten-link", url);
        },
        onTag(tag) {
          editorInstance.emit("zettelkasten-tag", tag);
        },
      }),
      referenceKeyEditListener: (intent) => {
        // The selection left a directly edited definition-id token: surface
        // the prompt intent to the shell (MainEditor.vue confirms and runs
        // the workspace rename protocol; declining keeps the local edit).
        editorInstance.emit("reference-key-edit-prompt", intent);
      },
    };

    let extensions: Extension[];
    switch (type) {
      case DocumentType.Markdown:
        extensions = getMarkdownExtensions(options);
        break;
      case DocumentType.LaTeX:
        extensions = getTexExtensions(options);
        break;
      case DocumentType.YAML:
        extensions = getYAMLExtensions(options);
        break;
      case DocumentType.JSON:
        extensions = getJSONExtensions(options);
        break;
    }

    // Carry an open review across state rebuilds. Every reload builds a fresh
    // EditorState, and configuring this compartment empty here used to drop the
    // merge extension while `activeReviewDiffSession` stayed set — so the
    // same-id early return in startReviewDiffSession decided there was nothing
    // to install, the accept/reject controls vanished, and the unresolved packet
    // could then be neither resolved nor saved. Rebuild it from the session
    // instead, which also covers reloads triggered by a settings change.
    extensions.push(
      this.reviewDiffCompartment.of(
        this.activeReviewDiffSession === null
          ? []
          : this.buildReviewExtension(this.activeReviewDiffSession),
      ),
    );
    return extensions;
  }

  /**
   * Loads the document from main and sets up everything required to display and
   * edit it.
   */
  async loadDocument(persistentState?: EditorViewPersistentState): Promise<void> {
    const { content, type, startVersion } = await this.authority.fetchDoc(this.representedDocument);

    // The documents contents have changed, so we must recreate the state
    const extensions = this._getExtensions(this.representedDocument, type, startVersion);
    // This particular editor type needs access to the window and leaf IDs
    extensions.push(editorMetadataFacet.of({ windowId: this.windowId, leafId: this.leafId }));

    const state = EditorState.create({
      doc: Text.of(content.split("\n")),
      extensions,
    });

    this._instance.setState(state);

    if (persistentState !== undefined) {
      // Now that the correct document has been loaded, there will be content
      // and we can restore the persisted information.
      //
      // The persisted positions describe the BUFFER as this pane last had it,
      // which is not necessarily what the authority hands back: a buffer whose
      // last edits were never acknowledged is longer than the document loaded
      // here. CodeMirror rejects a selection or a fold that points past the
      // end, and the throw would land as a document-load error — the file
      // would simply refuse to open, over a cursor. So bring the positions
      // into this document instead of trusting them.
      const { scrollSnapshot, selection, foldedRanges } = persistentState;
      const end = this._instance.state.doc.length;

      const effects: StateEffect<unknown>[] = [scrollSnapshot];

      const cursor = foldedRanges.iter();
      while (cursor.value) {
        if (cursor.to <= end) {
          effects.push(foldEffect.of({ from: cursor.from, to: cursor.to }));
        }
        cursor.next();
      }

      this._instance.dispatch({
        selection: EditorSelection.create(
          selection.ranges.map((range) =>
            EditorSelection.range(Math.min(range.anchor, end), Math.min(range.head, end)),
          ),
          selection.mainIndex,
        ),
        effects,
      });
    }

    // Ensure the theme switcher picks the state change up; this somehow doesn't
    // properly work after the document has been mounted to the DOM.
    this._instance.dispatch({ effects: configUpdateEffect.of(this.config) });

    // Provide the cached databases to the state (can be overridden by the
    // caller afterwards by calling setCompletionDatabase)
    this._instance.dispatch({
      effects: tagsUpdate.of(this.databaseCache.tags),
    });
    this._instance.dispatch({
      effects: citekeyUpdate.of(this.databaseCache.citations),
    });
    this._instance.dispatch({
      effects: snippetsUpdate.of(this.databaseCache.snippets),
    });
    this._instance.dispatch({
      effects: filesUpdate.of(this.databaseCache.files),
    });
    this._instance.dispatch({
      effects: referencesUpdate.of(this.databaseCache.references),
    });
    if (this.workspaceReferencesCache !== null) {
      this._instance.dispatch({
        effects: workspaceReferencesUpdate.of(this.workspaceReferencesCache),
      });
    }

    // Determine if this is a code doc and add the corresponding class to the
    // outer content DOM so that we can style it.
    if (type !== DocumentType.Markdown) {
      this._instance.contentDOM.classList.add("code");
    }

    this._instance.focus();

    this.emit("loaded");
  }

  /**
   * Returns an object containing information needed to refresh the entire
   * editor instance after it being unmounted. Request this once before
   * unmounting this instance, and provide it back to a new instance when you
   * re-instantiate the same document again.
   *
   * @return  {EditorViewPersistentState}  The persistent state object.
   */
  public get persistentState(): EditorViewPersistentState {
    return {
      scrollSnapshot: this._instance.scrollSnapshot(),
      selection: this._instance.state.selection,
      foldedRanges: this._instance.state.field(foldState, false) ?? Decoration.set([]),
    };
  }

  /**
   * This function allows to reload the full editor contents. This is useful if
   * a setting has changed that requires extensions to be fully reloaded.
   */
  async reload(): Promise<void> {
    await this.loadDocument();
  }

  /**
   * Unmount the editor instance entirely. NOTE: After calling this, DO NO
   * LONGER USE THIS CLASS INSTANCE! Instantiate it anew!
   */
  public unmount(): void {
    this.instance.destroy();
  }

  /**
   * Allows highlighting of arbitrary ranges independent of a search
   *
   * @param  {SelectionRange[]}  ranges  The ranges to highlight
   */
  highlightRanges(ranges: SelectionRange[]): void {
    this._instance.dispatch({ effects: highlightRangesEffect.of(ranges) });
  }

  /**
   * Pastes the clipboard contents as plain text, regardless of any formatted
   * text present.
   */
  pasteAsPlainText(): void {
    pasteAsPlain(this._instance);
  }

  /**
   * Copies the current editor contents into the clipboard as HTML
   */
  copyAsHTML(): void {
    copyAsHTML(this._instance);
  }

  /**
   * Small function that jumps to a specific line in the editor.
   *
   * @param  {number} line The line to pull into view
   */
  jtl(line: number): void {
    if (line > 0 && line <= this._instance.state.doc.lines) {
      const lineDesc = this._instance.state.doc.line(line);
      this._instance.dispatch({
        selection: { anchor: lineDesc.from, head: lineDesc.to },
        effects: EditorView.scrollIntoView(lineDesc.from, { y: "center" }),
      });
    }
    this._instance.focus();
  }

  /**
   * Restores a captured DocumentLocation (issue #1 Phase 5): the exact
   * selection, collapsed folds, and viewport scroll offset stamped onto a
   * per-pane history entry at jump time. Out-of-range ranges (the document
   * changed since the capture) are dropped rather than clamped wrongly.
   *
   * @param   {DocumentLocation}  location  The location to restore
   */
  restoreDocumentLocation(location: DocumentLocation): void {
    const docLength = this._instance.state.doc.length;
    const { anchor, head } = location.selection;
    const effects = location.folds
      .filter((fold) => fold.from >= 0 && fold.to <= docLength && fold.from < fold.to)
      .map((fold) => foldEffect.of({ from: fold.from, to: fold.to }));

    if (anchor >= 0 && anchor <= docLength && head >= 0 && head <= docLength) {
      this._instance.dispatch({ selection: { anchor, head }, effects });
    } else if (effects.length > 0) {
      this._instance.dispatch({ effects });
    }

    this._instance.scrollDOM.scrollTop = location.scrollTop;
    this._instance.focus();
  }

  /**
   * Selects the given source range and scrolls it into view (issue #1
   * Phase 5): the landing step of a cross-file reference jump, targeting the
   * authored definition id token.
   *
   * @param   {SourceRange}  range  The range to select
   */
  selectSourceRange(range: SourceRange): void {
    const docLength = this._instance.state.doc.length;
    if (range.from < 0 || range.to > docLength || range.from > range.to) {
      return; // The document changed since the range was computed.
    }

    this._instance.dispatch({
      selection: { anchor: range.from, head: range.to },
      effects: EditorView.scrollIntoView(range.from, { y: "center" }),
    });
    this._instance.focus();
  }

  /**
   * Moves the section that starts with an ATX heading on the from-line to the
   * line identified by to
   *
   * @param   {number}  from  The starting line (including the section heading)
   * @param   {number}  to    The target line for the section (is -1 if it should be moved to the end)
   */
  moveSection(from: number, to: number): void {
    const toc = this._instance.state.field(tocField);
    const toLineNumber = to !== -1 ? to : this._instance.state.doc.lines;
    moveSection(toc, from, toLineNumber)(this._instance);
  }

  /**
   * Toggles the visibility of the search panel in this editor state.
   */
  toggleSearchPanel() {
    if (searchPanelOpen(this.instance.state)) {
      closeSearchPanel(this.instance);
    } else {
      openSearchPanel(this.instance);
    }
  }

  /**
   * Updates the provided options for all currently loaded documents.
   *
   * @param   {Object}  newOptions  The new options
   */
  setOptions(newOptions: EditorConfigOptions): void {
    // Here, we only trigger an update in the state itself. Then, we grab the
    // update via an effect to ensure we can cache the final, correct
    // configuration. However, in case there's no state (initial update), we
    // still need to cache the config here, as the updateListener won't be
    // firing yet.

    // Cache the current config first, and then apply it
    this.onConfigUpdate(newOptions);

    this.config = safeAssign(newOptions, this.config);

    this._instance.dispatch({ effects: configUpdateEffect.of(this.config) });
  }

  /**
   * This function is called by an updateListener that listens for changes to
   * the main configuration. We do so to ensure that the editor state is the
   * main source of truth, but that the editor class can cache the config in
   * case we need to exchange the states.
   *
   * @param   {Partial<EditorConfiguration>}  newOptions  The new options passed via the effect
   */
  private onConfigUpdate(newOptions: Partial<EditorConfiguration>): void {
    const inputModeChanged =
      newOptions.inputMode !== undefined && newOptions.inputMode !== this.config.inputMode;
    const darkModeChanged =
      newOptions.darkMode !== undefined && newOptions.darkMode !== this.config.darkMode;
    const editorModeChanged =
      newOptions.darkModeEditor !== undefined &&
      newOptions.darkModeEditor !== this.config.darkModeEditor;
    const themeChanged = newOptions.theme !== undefined && newOptions.theme !== this.config.theme;

    // Third: The input mode, if applicable
    if (inputModeChanged) {
      if (newOptions.inputMode === "emacs") {
        this._instance.dispatch({
          effects: inputModeCompartment.reconfigure(emacs()),
        });
      } else if (newOptions.inputMode === "vim") {
        const vimFactory: unknown = vimPlugin;
        if (typeof vimFactory !== "function") {
          throw new TypeError("The Vim editor extension factory is unavailable.");
        }
        const createVimExtension = vimFactory as () => Extension;
        this._instance.dispatch({
          effects: inputModeCompartment.reconfigure(createVimExtension()),
        });
      } else {
        this._instance.dispatch({
          effects: inputModeCompartment.reconfigure([]),
        });
      }
    }

    // Fourth: Switch theme, if applicable
    if (darkModeChanged || editorModeChanged || themeChanged) {
      const themes = getMainEditorThemes();

      const darkMode = newOptions.darkMode ?? this.config.darkMode;
      const darkModeEditor = newOptions.darkModeEditor ?? this.config.darkModeEditor;

      this._instance.dispatch({
        effects: darkModeEffect.of({
          darkMode: useDarkModeEditor(darkMode, darkModeEditor),
          ...themes[newOptions.theme ?? this.config.theme],
        }),
      });
    }
  }

  /**
   * Returns an option with the given name as it is configured on the instance.
   *
   * @param   {string}  name  The name of the key to request
   *
   * @return  {any}           The value of the key
   */
  getOption(name: string) {
    const config = this._instance.state.field(configField);
    if (name in config) {
      return config[name as keyof EditorConfiguration];
    }
  }

  /**
   * Runs a command on the underlying CodeMirror instance
   *
   * @param   {String}  cmd  The command to run
   */
  runCommand(cmd: string): void {
    switch (cmd) {
      case "markdownComment":
        applyComment(this._instance);
        break;
      case "markdownLink":
        insertLink(this._instance);
        break;
      case "markdownImage":
        insertImage(this._instance);
        break;
      case "insertFootnote":
        addNewFootnote(this._instance);
        break;
      case "markdownMakeTaskList":
        applyTaskList(this._instance);
        break;
      case "createReferenceLabel":
        createReferenceLabel(this._instance);
        break;
      default:
        console.warn("Unimplemented command:", cmd);
    }
  }

  /**
   * Replaces the main selection with arbitrary text
   *
   * @param   {string}  text  The text to replace the selection with
   */
  replaceSelection(text: string): void {
    const transaction = this._instance.state.replaceSelection(text);
    this._instance.dispatch(transaction);
    this._instance.focus();
  }

  /**
   * Insert a fenced div, `::: {#id}`,
   * or bracketed span, `[my text]{#id}`
   * around the main selection.
   *
   * @param   {string}  type        The type of div to insert
   * @param   {string}  identifier  Identifier attribute. Spaces are replaced with a hyphen `-`
   * @param   {string}  classes     Class attributes. Words are prepended with `.`
   * @param   {string}  attributes  Key=Value attributes.
   */
  insertPandocDivOrSpan(type: "div" | "span", attributes: string): void {
    applyPandocDivOrSpan(this._instance, type, parsePandocAttributes(attributes));
  }

  /**
   * Issues a focus command to the underlying instance
   */
  focus(): void {
    this._instance.focus();
  }

  /**
   * Whether the underlying Codemirror instance is currently focused
   *
   * @return  {boolean} The focus status
   */
  hasFocus(): boolean {
    return this._instance.hasFocus;
  }

  /**
   * Whether any element (including the editor, but also any widgets or other
   * elements inside the entire editor DOM element) has currently focus.
   *
   * @return  {boolean} The focus status
   */
  hasFocusWithin(): boolean {
    return this._instance.dom.contains(document.activeElement);
  }

  /* Sets the project info field of the editor state to the provided value.
   *
   * @param   {ProjectInfo|null}  info  The data
   */
  set projectInfo(info: ProjectInfo | null) {
    this._instance.dispatch({ effects: projectInfoUpdateEffect.of(info) });
  }

  /**
   * Sets an autocomplete database of given type to a new value
   *
   * @param   {String}  type      The type of the database
   * @param   {Object}  database  The show-hint-addon compatible database
   */
  setCompletionDatabase(type: "tags", database: TagRecord[]): void;
  setCompletionDatabase(
    type: "citations",
    database: Array<{ citekey: string; displayText: string }>,
  ): void;
  setCompletionDatabase(type: "snippets", database: Array<{ name: string; content: string }>): void;
  setCompletionDatabase(
    type: "files",
    database: Array<{ filename: string; displayName: string; id: string }>,
  ): void;
  setCompletionDatabase(type: "references", database: ReferenceCompletionEntry[]): void;
  setCompletionDatabase(type: string, database: unknown): void {
    if (!Array.isArray(database)) {
      throw new TypeError(`Completion database for ${type} must be an array.`);
    }

    switch (type) {
      case "tags":
        this.databaseCache.tags = database as TagRecord[];
        this._instance.dispatch({
          effects: tagsUpdate.of(this.databaseCache.tags),
        });
        break;
      case "citations":
        this.databaseCache.citations = database as Array<{ citekey: string; displayText: string }>;
        this._instance.dispatch({
          effects: citekeyUpdate.of(this.databaseCache.citations),
        });
        break;
      case "snippets":
        this.databaseCache.snippets = database as Array<{ name: string; content: string }>;
        this._instance.dispatch({
          effects: snippetsUpdate.of(this.databaseCache.snippets),
        });
        break;
      case "files":
        this.databaseCache.files = database as Array<{
          filename: string;
          displayName: string;
          id: string;
        }>;
        this._instance.dispatch({
          effects: filesUpdate.of(this.databaseCache.files),
        });
        break;
      case "references":
        this.databaseCache.references = database as ReferenceCompletionEntry[];
        this._instance.dispatch({
          effects: referencesUpdate.of(this.databaseCache.references),
        });
        break;
    }
  }

  /**
   * Provides the editor state with a new resolved workspace reference view
   * (issue #1 Phase 4): the single typed source behind reference chips,
   * definition badges, reference hovers, and reference diagnostics.
   *
   * @param  {EditorWorkspaceReferences}  references  The resolved view
   */
  setWorkspaceReferences(references: EditorWorkspaceReferences): void {
    this.workspaceReferencesCache = references;
    this._instance.dispatch({
      effects: workspaceReferencesUpdate.of(references),
    });
  }

  /**
   * Installs the one thing allowed to act on a review decision. The editor
   * raises no review events of its own: a fire-and-forget event left the
   * click and the IPC call unordered, so a decision could reach main before
   * the edit the reviewer made just above it. The client awaits instead, and
   * its rejection is what hands the widget's controls back.
   */
  setReviewActionClient(client: ReviewActionClient): void {
    this.reviewActionClient = client;
  }

  startReviewDiffSession(session: ReviewDiffSession): void {
    if (session.documentPath !== this.representedDocument) {
      return;
    }

    // Never mount controls over a renderer buffer that is not the provider's
    // authoritative working text. The collab update will retry activation;
    // until then the pane is ordinary editable Markdown with no stale action.
    if (this._instance.state.doc.toString() !== session.workingText) {
      this.pendingReviewDiffSession = session;
      this.activeReviewDiffSession = null;
      this._instance.dom.classList.remove("review-diff-active");
      this._instance.dispatch({ effects: this.reviewDiffCompartment.reconfigure([]) });
      return;
    }
    this.pendingReviewDiffSession = null;
    if (
      this.activeReviewDiffSession?.id === session.id &&
      this.activeReviewDiffSession.reviewGeneration === session.reviewGeneration &&
      this.activeReviewDiffSession.referenceText === session.referenceText &&
      this.activeReviewDiffSession.workingText === session.workingText &&
      JSON.stringify(this.activeReviewDiffSession.packets) === JSON.stringify(session.packets) &&
      JSON.stringify(this.activeReviewDiffSession.chunkComments) === JSON.stringify(session.chunkComments) &&
      JSON.stringify(this.activeReviewDiffSession.comments) === JSON.stringify(session.comments)
    ) {
      return;
    }

    this.activeReviewDiffSession = session;
    this._instance.dom.classList.add("review-diff-active");
    this._instance.dispatch({
      effects: this.reviewDiffCompartment.reconfigure(this.buildReviewExtension(session)),
    });
    this._instance.focus();
  }

  /**
   * The review extension for a session: chunk widgets computed from the
   * provider's merge reference against this buffer, with decisions emitted
   * upward. MainEditor forwards them to the provider, whose next broadcast is
   * the only thing that changes review state here.
   */
  private buildReviewExtension(session: ReviewDiffSession): ReturnType<typeof reviewChunksExtension> {
    // Every callback binds the generation of the session these widgets were
    // DRAWN from, not whatever the newest broadcast carries. That is the
    // whole point: the decision is bound to what the reviewer was looking at
    // when they clicked, so a session that changed underneath refuses.
    const client = (): ReviewActionClient => {
      if (this.reviewActionClient === null) {
        throw new Error("no review action client is installed on this editor");
      }
      return this.reviewActionClient;
    };
    const reviewId = session.id;
    const expectedReviewGeneration = session.reviewGeneration;
    return reviewChunksExtension({
      reviewId,
      referenceText: session.referenceText,
      packets: session.packets,
      chunkComments: session.chunkComments,
      comments: session.comments,
      onDecide: async (chunkId, decision) =>
        await client().decide({
          reviewId,
          expectedReviewGeneration,
          chunkId,
          decision,
        }),
      onAcceptAll: async () =>
        await client().acceptAll({ reviewId, expectedReviewGeneration }),
      onClear: async () => await client().clear({ reviewId, expectedReviewGeneration }),
      onComment: async (text) =>
        await client().comment({ reviewId, expectedReviewGeneration, text }),
      onChunkComment: async (chunkId, text) =>
        await client().commentChunk({ reviewId, expectedReviewGeneration, chunkId, text }),
    });
  }

  private activatePendingReviewDiffSession(): void {
    const session = this.pendingReviewDiffSession;
    if (session !== null && this._instance.state.doc.toString() === session.workingText) {
      this.startReviewDiffSession(session);
    }
  }

  clearReviewDiffSession(sessionId?: string): void {
    if (this.activeReviewDiffSession === null) {
      if (sessionId === undefined || this.pendingReviewDiffSession?.id === sessionId) {
        this.pendingReviewDiffSession = null;
      }
      return;
    }

    if (sessionId !== undefined && this.activeReviewDiffSession.id !== sessionId) {
      return;
    }

    this.activeReviewDiffSession = null;
    this.pendingReviewDiffSession = null;
    this._instance.dom.classList.remove("review-diff-active");
    this._instance.dispatch({
      effects: this.reviewDiffCompartment.reconfigure([]),
    });
  }

  /* * * * * * * * * * * *
   * GETTERS AND SETTERS *
   * * * * * * * * * * * */

  /**
   * This function builds a table of contents based on the editor contents
   *
   * @return {Array} An array containing objects with all headings
   */
  get tableOfContents(): ToCEntry[] | undefined {
    return this._instance.state.field(tocField, false);
  }

  /**
   * Returns info about the editor instance
   *
   * @return  {Object}  An object containing, e.g., words, chars, selections.
   */
  get documentInfo(): DocumentInfo {
    // First, we need the main selection's main offset in the document and
    // compute the correct line number for that offset, in order to arrive at
    // a cursor position.
    const mainOffset = this._instance.state.selection.main.head;
    const line = this._instance.state.doc.lineAt(mainOffset);
    const markdownAstFactory: unknown = markdownToAST;
    if (typeof markdownAstFactory !== "function") {
      throw new TypeError("The Markdown AST factory is unavailable.");
    }
    const ast = markdownAstFactory as (
      markdown: string,
      tree: ReturnType<typeof syntaxTree>,
    ) => MarkdownDocument | ASTNode;
    const documentAst = ast(this._instance.state.sliceDoc(), syntaxTree(this._instance.state));
    const locale: string = window.config.get("appLang");
    return {
      words: this.wordCount ?? 0,
      chars: this.charCount ?? 0,
      cursor: { line: line.number, ch: mainOffset - line.from + 1 }, // Chars are still zero-based
      selections: this._instance.state.selection.ranges
        // Remove cursor-only positions
        .filter((sel) => !sel.empty)
        // Then map to user readable ranges
        .map((sel) => {
          // Analogous to how we determine the cursor position we do it here for
          // each selection present.
          const anchorLine = this._instance.state.doc.lineAt(sel.anchor);
          const headLine = this._instance.state.doc.lineAt(sel.head);
          const { words, chars } = countAll(documentAst, locale, sel.from, sel.to);
          return {
            anchor: {
              line: anchorLine.number,
              ch: sel.from - anchorLine.from + 1,
            },
            head: { line: headLine.number, ch: sel.to - headLine.from + 1 },
            words,
            chars,
          };
        }),
    };
  }

  /**
   * Whether the editor is currently in typewriter
   *
   * @return  {Boolean}  True if typewriter mode is active
   */
  get hasTypewriterMode(): boolean {
    return this.config.typewriterMode;
  }

  /**
   * Activates or deactivates typewriter mode
   *
   * @param   {Boolean}  shouldBeTypewriter  True or False
   */
  set hasTypewriterMode(shouldBeTypewriter: boolean) {
    this.config.typewriterMode = shouldBeTypewriter;
    this._instance.dispatch({
      effects: configUpdateEffect.of({ typewriterMode: shouldBeTypewriter }),
    });
  }

  /**
   * Determines whether the editor is in distraction free mode
   *
   * @return  {boolean}  True or false
   */
  get distractionFree(): boolean {
    return this._instance.state.field(configField, false)?.distractionFree ?? false;
  }

  /**
   * Sets the editor into or out of distraction free
   *
   * @param   {boolean}  shouldBeFullscreen  Whether the editor should be in distraction free
   */
  set distractionFree(shouldBeFullscreen: boolean) {}

  /**
   * Returns whether or not the readability mode is currently active
   *
   * @return  {boolean}  True if the readability mode is active
   */
  get readabilityMode(): boolean {
    return this._instance.state.field(configField).readabilityMode;
  }

  /**
   * Sets the readability mode
   *
   * @param   {boolean}  shouldBeReadability  Whether or not the mode should be active
   */
  set readabilityMode(shouldBeReadability: boolean) {
    this.config.readabilityMode = shouldBeReadability;
    this._instance.dispatch({ effects: configUpdateEffect.of(this.config) });
  }

  /**
   * Returns the current contents of the editor
   *
   * @return  {String}  The editor contents
   */
  get value(): string {
    return [...this._instance.state.doc.iterLines()].join("\n");
  }

  /**
   * Formats the current document with the injected formatter (issue #26),
   * applying the result as a single, cursor-preserving undo step. A typed
   * failure leaves the buffer untouched and is returned to the caller — the
   * renderer surfaces it. The formatter is injected so this class (part of the
   * shared editor core) never imports the electron-bound IPC formatter.
   *
   * @param   {MarkdownFormatter}      formatter  The formatter to run.
   *
   * @return  {Promise<FormatResult>}             The typed format result.
   */
  async runFormatter(formatter: MarkdownFormatter): Promise<FormatResult> {
    return formatDocument(this._instance, formatter);
  }

  /**
   * Resolves once every pending change has been pushed to the document
   * authority (there are no sendable collab updates left), and THROWS when
   * `timeout` ms pass with updates still unsent. Callers use this to order a
   * format-then-save: the on-disk write must see the formatted bytes, so the
   * format's collab update has to reach main first, and a caller that cannot be
   * given that ordering must hear about it instead of saving anyway.
   *
   * @param   {number}         timeout  Backstop in ms (default 2000).
   *
   * @return  {Promise<void>}
   */
  async whenSynced(timeout = 2000): Promise<void> {
    await whenAuthoritySynced(() => this._instance.state, timeout);
  }

  /**
   * Returns the outer DOM element for the editor instance
   *
   * @return  {HTMLElement}The editor wrapper
   */
  get dom(): HTMLElement {
    return this._instance.dom;
  }

  /**
   * Returns the word count of the editor contents
   *
   * @return  {Number}  The word count
   */
  get wordCount(): number | undefined {
    return this._instance.state.field(countField, false)?.words;
  }

  /**
   * Returns the char count of the editor contents
   *
   * @return  {Number}  The number of characters
   */
  get charCount(): number | undefined {
    return this._instance.state.field(countField, false)?.chars;
  }

  /**
   * Returns the underlying Codemirror instance
   *
   * @return  {EditorView}  The instance
   */
  get instance(): EditorView {
    return this._instance;
  }

  /**
   * Retrieves the document represented by this editor instance.
   *
   * @return  {string}  the absolute path to the document.
   */
  get documentPath(): string {
    return this.representedDocument;
  }
}
