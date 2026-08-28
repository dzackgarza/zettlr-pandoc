/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        getConfigTemplate utility function
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Returns a functional template to be used by the config provider.
 *
 * END HEADER
 */

import getLanguageFile from "@common/util/get-language-file";
import { NAVIGATION_SHORTCUT_DEFAULTS } from "@common/util/navigation-shortcuts";
import * as bcp47 from "bcp-47";
import { app, nativeTheme } from "electron";
import { v4 as uuid4 } from "uuid";

export type MarkdownTheme = "berlin" | "frankfurt" | "bielefeld" | "karl-marx-stadt" | "bordeaux";

// This is a handy interface to add groups of file types to the settings in
// order to allow users to display them in filemanager and/or sidebar, and open
// internally or externally.
// NOTE: The generics are meant so that you can restrict certain groupings.
// E.g., FileTypeSettings<true, false, 'zettlr'> enforces these values for the
// three properties.
interface FileTypeSettings<F = boolean, S = boolean, O = "zettlr" | "system"> {
  showInFilemanager: F;
  showInSidebar: S;
  openWith: O;
}

/**
 * This type describes an entry of the ignored rules array in the config. We
 * define this type here, and not in the LanguageTool command, because if we
 * change its structure, bad things could happen. By colocating it with the
 * config, it is harder for us to forget to write a migration rule if we ever
 * change this structure.
 */
export interface LanguageToolIgnoredRuleEntry {
  /**
   * The description of the rule (usually localized).
   */
  description: string;
  /**
   * The unique ID of this rule.
   */
  id: string;
  /**
   * The category for this rule.
   */
  category: string;
}

export interface AgentApiConfig {
  enabled: boolean;
  /**
   * Loopback port for the HTTP listener. `0` requests a kernel-assigned port.
   * In every case the actual bound port is published to the `agent-api.port`
   * file in the user-data directory once the listener is up.
   */
  port: number;
}

export interface ReferenceConfig {
  authorityReportDebounceMs: number;
}

export interface ConfigOptions {
  version: string;
  buildDate: string;
  uuid: string;
  appLang: string;
  /** Agent API HTTP server configuration (OpenAPI / REST). */
  agentApi: AgentApiConfig;
  /** Workspace-reference extraction policy. */
  references: ReferenceConfig;

  darkMode: boolean;
  darkModeEditor: "match" | "light" | "dark";
  autoDarkMode: "off" | "system" | "schedule";
  autoDarkModeStart: string;
  autoDarkModeEnd: string;

  openDirectory: string | null;
  attachmentExtensions: string[];
  alwaysReloadFiles: boolean;
  muteLines: boolean;

  // NOTE to everyone: These options (and possibly others) that pertain to the
  // file manager should slowly be migrated into the fileManager group below.
  fileManagerMode: "thin" | "combined" | "expanded";
  fileManagerShowFiles: boolean;
  fileManagerShowWorkspaces: boolean;
  fileMeta: boolean;
  fileMetaTime: "modtime" | "creationtime";
  sorting: "natural" | "ascii";
  sortFoldersFirst: boolean;
  fileNameDisplay: "filename" | "title" | "heading" | "title+heading";

  // NOTE to everyone: The various filemanager options (see above) should over
  // time be migrated into this group.
  fileManager: {
    twoStepCollapseWorkspaces: boolean;
    // If this is true, the config will never attempt to auto-sort workspaces.
    sortWorkspacesManually: boolean;
  };

  newFileNamePattern: string;
  newFileDontPrompt: boolean;
  selectedDicts: string[];

  debug: boolean;
  checkForBeta: boolean;

  app: {
    openFiles: string[];
    openWorkspaces: string[];
  };

  dialogPaths: {
    askFileDialog: string;
    askDirDialog: string;
    askLangFileDialog: string;
  };
  tikz: {
    /** Optional Pandoc data tree for editor TikZ rendering. */
    dataDir: string;
  };
  export: {
    dir: "temp" | "cwd" | "ask";
    stripTags: boolean;
    autoOpenExportedFiles: boolean;
    enforceMarkSupport: boolean;
    stripLinks: "full" | "unlink" | "no";
    cslLibrary: string;
    cslStyle: string;
    useBundledPandoc: boolean;
    exportQmdWithQuarto: boolean;
    customCommands: Array<{ displayName: string; command: string }>;
    // Ordered list of Pandoc filters applied to every export before the
    // profile's own filters. Names resolve from Pandoc's data directory
    // (~/.pandoc/filters) or an absolute path. Ordered and declared, unlike the
    // former implicit fs.readdir sweep of the lua-filter directory.
    filters: string[];
    // Whether the exporter injects its own local MathJax config/preamble into
    // HTML and TeX exports (self-contained, offline). Turn off to defer math to
    // the profile's template (e.g. a ~/.pandoc template that owns MathJax).
    injectMathHeaders: boolean;
    // Default Pandoc templates applied per writer family when the export profile
    // declares none. A path (absolute, or a name resolved from ~/.pandoc/templates).
    // htmlTemplate covers html/revealjs; latexTemplate covers latex/pdf/beamer.
    htmlTemplate: string;
    latexTemplate: string;
    // Declarative, pipeline-integrated export scripts. Each becomes a first-class
    // Format item: export the source through the named base Pandoc `profile` to
    // an intermediate, then run `command "<intermediate>" "<output>"`, producing
    // an `extension` file. Unlike customCommands (raw source), the script
    // receives the Pandoc-processed output.
    scripts: Array<{
      name: string;
      profile: string;
      command: string;
      extension: string;
    }>;
    selectedProfiles: Array<{ filePath: string; profile: string }>;
    lastUsedProfile: string;
  };
  zkn: {
    idRE: string;
    idGen: string;
    linkAddFileTitle: boolean;
    linkWithIDIfPossible: boolean;
    linkFormat: "link|title" | "title|link";
    autoSearch: boolean;
    customDirectory: string;
  };
  editor: {
    autocompleteSuggestEmojis: boolean;
    snippetAutocompleteTriggerCharacter: ":";
    autoSave: "off" | "immediately" | "delayed";
    // Run flowmark over the document on every save (issue #26). Off by default.
    formatOnSave: boolean;
    citeStyle: "in-text" | "in-text-suffix" | "regular";
    autoCloseBrackets: boolean;
    showLinkPreviews: boolean;
    showStatusbar: boolean;
    showFormattingToolbar: boolean;
    showWhitespace: boolean;
    showMarkdownLineNumbers: boolean;
    defaultSaveImagePath: string;
    enableTableHelper: boolean;
    indentUnit: number;
    indentWithTabs: boolean;
    alwaysIndentLineOnTab: boolean;
    fontSize: number;
    countChars: boolean;
    // The per-pane history Back/Forward combos (issue #1 workstream 4), in
    // CodeMirror keybinding syntax. Defaults come from the shared
    // NAVIGATION_SHORTCUT_DEFAULTS registry.
    navigationShortcuts: {
      back: string;
      forward: string;
    };
    inputMode: "default" | "vim" | "emacs";
    boldFormatting: "**" | "__";
    italicFormatting: "_" | "*";
    highlightFormatting: "span" | "==";
    readabilityAlgorithm: "dale-chall" | "gunning-fog" | "coleman-liau" | "automated-readability";
    lint: {
      markdown: boolean;
      languageTool: {
        active: boolean;
        level: "picky" | "default";
        motherTongue: string; // e.g., en-US, de-DE
        variants: {
          en: string;
          de: string;
          pt: string;
          ca: string;
        };
        ignoredRules: LanguageToolIgnoredRuleEntry[];
        provider: "official" | "custom";
        customServer: string;
        username: string;
        apiKey: string;
      };
    };
    autoCorrect: {
      active: boolean;
      magicQuotes: {
        primary: string;
        secondary: string;
      };
      replacements: Array<{ key: string; value: string }>;
      matchWholeWords: boolean;
    };
  };
  display: {
    theme: MarkdownTheme;
    hideToolbarInDistractionFree: boolean;
    markdownFileExtensions: boolean;
    previewModeShowSyntaxWhenCursorIsAdjacent: boolean;
    imageWidth: number;
    imageHeight: number;
    renderingMode: "preview" | "raw";
    renderCitations: boolean;
    renderIframes: boolean;
    renderImages: boolean;
    renderLinks: boolean;
    renderMath: boolean;
    renderTasks: boolean;
    renderHTags: boolean;
    renderEmphasis: boolean;
    renderPandoc: boolean;
    renderHorizontalRules: boolean;
  };
  files: {
    // Built-in files cannot be shown in the sidebar, will always be shown in
    // the file manager, and will always be opened with Zettlr.
    builtin: FileTypeSettings<true, false, "zettlr">;
    // Images and PDFs can be entirely hidden or shown everywhere, and opened
    // with the system default, or in Zettlr
    images: FileTypeSettings;
    pdf: FileTypeSettings;
    // These file types can be shown anywhere, but are not open-able by Zettlr.
    msoffice: FileTypeSettings<boolean, boolean, "system">;
    openOffice: FileTypeSettings<boolean, boolean, "system">;
    dataFiles: FileTypeSettings<boolean, boolean, "system">;
    dotFiles: FileTypeSettings<boolean, boolean>;
  };
  watchdog: {
    activatePolling: boolean;
    stabilityThreshold: number;
  };
  window: {
    nativeAppearance: boolean;
    vibrancy: boolean;
    sidebarVisible: boolean;
    fileManagerVisible: boolean;
    currentSidebarTab: "toc" | "references" | "relatedFiles" | "attachments";
    recentGlobalSearches: string[];
  };
  ui: {
    fileManagerSplitSize: [number, number];
    editorSidebarSplitSize: [number, number];
  };
  system: {
    deleteOnFail: boolean;
    leaveAppRunning: boolean;
    avoidNewTabs: boolean;
    iframeWhitelist: string[];
    checkForUpdates: boolean;
    zoomBehavior: "gui" | "editor";
  };
  displayToolbarButtons: {
    showOpenPreferencesButton: boolean;
    showNewFileButton: boolean;
    showPreviousFileButton: boolean;
    showNextFileButton: boolean;
    showPandocDivSpanButton: boolean;
    showMarkdownCommentButton: boolean;
    showMarkdownLinkButton: boolean;
    showMarkdownImageButton: boolean;
    showMarkdownMakeTaskListButton: boolean;
    showInsertTableButton: boolean;
    showInsertFootnoteButton: boolean;
    showDocumentInfoText: boolean;
    showPomodoroButton: boolean;
  };
}

export function getConfigTemplate(): ConfigOptions {
  // Before returning the settings object, we have to make sure we retrieve a
  // locale that is both installed as a translation AND more or less the user's
  // wish.
  let locale = app.getLocale();
  let locSchema = bcp47.parse(locale);
  if (locSchema.language === undefined) {
    // Fall back to en-US
    locale = "en-US";
  } else {
    // Return the best match that the app can find (only the tag).
    locale = getLanguageFile(locale).tag;
  }

  // Return the complete configuration object
  return {
    version: app.getVersion(), // Useful for migrating
    buildDate: __BUILD_DATE__,
    app: {
      openFiles: [],
      openWorkspaces: [],
    },
    openDirectory: null, // Save last opened dir path here
    dialogPaths: {
      askFileDialog: "",
      askDirDialog: "",
      askLangFileDialog: "",
    },
    tikz: {
      dataDir: "",
    },
    window: {
      // Only use native window appearance by default on macOS. If this value
      // is false, this means that Zettlr will display the menu bar and window
      // controls as defined in the HTML.
      nativeAppearance: process.platform === "darwin", // Linux only
      vibrancy: false,
      // Store a few GUI related settings here as well
      fileManagerVisible: true,
      sidebarVisible: false,
      currentSidebarTab: "toc",
      recentGlobalSearches: [],
    },
    ui: {
      fileManagerSplitSize: [20, 80],
      editorSidebarSplitSize: [80, 20],
    },
    // Visible attachment filetypes
    attachmentExtensions: [],
    // UI related options
    darkMode: nativeTheme.shouldUseDarkColors,
    darkModeEditor: "match", // Possible values: 'match', 'light', 'dark'
    alwaysReloadFiles: true, // Should Zettlr automatically load remote changes?
    autoDarkMode: "system", // Possible values: 'off', 'system', 'schedule', 'auto'
    autoDarkModeStart: "21:00", // Switch into dark mode at this time
    autoDarkModeEnd: "06:00", // Switch to light mode at this time
    fileMeta: true,
    fileMetaTime: "modtime", // The time to be displayed in file meta
    sorting: "natural", // Can be natural or based on ASCII values
    sortFoldersFirst: true, // should folders be shown first in combined fileview
    muteLines: true, // Should the editor mute lines in distraction free mode?
    fileManagerMode: "combined", // thin = Preview or directories visible --- expanded = both visible --- combined = tree view displays also files
    fileManagerShowFiles: true, // Allow users to persistently collapse or uncollapse the files and workspaces sections.
    fileManagerShowWorkspaces: true,
    fileNameDisplay: "title+heading", // Controls what info is displayed as filenames
    fileManager: {
      twoStepCollapseWorkspaces: false,
      sortWorkspacesManually: false, // By default, let Zettlr sort workspaces
    },
    newFileNamePattern: "%id.md",
    newFileDontPrompt: false, // If true immediately creates files
    export: {
      dir: "temp", // Can either be "temp", "cwd" (current working directory) or "ask"
      stripTags: false, // Strip tags a.k.a. #tag
      autoOpenExportedFiles: true,
      enforceMarkSupport: true,
      stripLinks: "full", // Strip internal links: "full" - remove completely, "unlink" - only remove brackets, "no" - don't alter
      cslLibrary: "", // Path to a CSL JSON library file
      cslStyle: "", // Path to a CSL Style file
      useBundledPandoc: true, // Whether to use the bundled Pandoc
      exportQmdWithQuarto: false, // Whether .qmd-files should be exported with Quarto
      customCommands: [], // Custom commands that the user can use to run arbitrary exports
      filters: [], // Ordered Pandoc filters applied to every export (resolved from ~/.pandoc/filters)
      injectMathHeaders: true, // Inject local MathJax config/preamble into exports; off defers to the profile template
      htmlTemplate: "", // Default Pandoc template for HTML/revealjs exports (when the profile declares none)
      latexTemplate: "", // Default Pandoc template for latex/pdf/beamer exports (when the profile declares none)
      scripts: [], // Pipeline-integrated export scripts (base profile -> command -> output); see interface above
      selectedProfiles: [], // Remembers the last chosen exporter per file for easy re-exporting
      lastUsedProfile: "HTML.yaml", // Remembers the last chosen exporter for easy re-exporting
    },
    // Zettelkasten stuff (IDs, as well as link matchers)
    zkn: {
      idRE: "(\\d{14})",
      idGen: "%Y%M%D%h%m%s",
      linkAddFileTitle: true,
      linkWithIDIfPossible: false,
      linkFormat: "link|title", // Determines what internal links ([[link|title]]) look like
      autoSearch: true, // Automatically start a search upon following a link?
      customDirectory: "", // If present, saves auto-created files here
    },
    // Editor related stuff
    editor: {
      autoSave: "off",
      formatOnSave: false, // Run flowmark on save (issue #26)
      autocompleteSuggestEmojis: true,
      snippetAutocompleteTriggerCharacter: ":",
      autoCloseBrackets: true,
      showLinkPreviews: true, // Whether to fetch link previews in the editor
      showWhitespace: false,
      showMarkdownLineNumbers: false,
      defaultSaveImagePath: "",
      citeStyle: "regular", // Determines how autocomplete will complete citations
      enableTableHelper: true, // Enable the table helper plugin
      indentUnit: 4, // The number of spaces to be added
      indentWithTabs: false,
      alwaysIndentLineOnTab: false, // Whether `Tab` always indents the current line
      fontSize: 18, // The editor's font size in pixels
      countChars: false, // Set to true to enable counting characters instead of words
      navigationShortcuts: { ...NAVIGATION_SHORTCUT_DEFAULTS }, // Back/Forward history combos
      inputMode: "default", // Can be default, vim, emacs
      boldFormatting: "**", // Can be ** or __
      italicFormatting: "_", // Can be * or _
      highlightFormatting: "==", // Can be 'span' or ==
      readabilityAlgorithm: "dale-chall", // The algorithm to use with readability mode.
      showStatusbar: true,
      showFormattingToolbar: true,
      lint: {
        markdown: true, // Should Markdown be linted?
        languageTool: {
          active: false, // Utilize languageTool?
          level: "picky", // API: https://languagetool.org/http-api/#!/default/post_check
          motherTongue: "", // Optional motherTongue property
          variants: {
            // These defaults are taken from LT's extension
            en: "en-US",
            de: "de-DE",
            pt: "pt-PT",
            ca: "ca-ES",
          },
          // This is an (initially empty) array of rules the user chose to
          // ignore globally.
          ignoredRules: [],
          provider: "official",
          customServer: "",
          username: "",
          apiKey: "",
        },
      },
      autoCorrect: {
        active: true, // AutoCorrect is on by default
        magicQuotes: {
          // Can be various quote pairs. The default characters (" and ')
          // will disable magic quotes.
          primary: '"…"',
          secondary: "'…'",
        },
        replacements: [
          // Arrows
          { key: "-->", value: "→" },
          { key: "–>", value: "→" }, // For Word mode arrows
          { key: "<--", value: "←" },
          { key: "<->", value: "↔" },
          { key: "<-->", value: "↔" },
          { key: "==>", value: "⇒" },
          { key: "<==", value: "⇐" },
          { key: "<=>", value: "⇔" },
          { key: "<==>", value: "⇔" },
          // Mathematical symbols
          { key: "!=", value: "≠" },
          { key: "<>", value: "≠" },
          { key: "+-", value: "±" },
          { key: ":time:", value: "×" },
          { key: ":division:", value: "÷" },
          { key: "<=", value: "≤" },
          { key: ">=", value: "≥" },
          { key: "1/2", value: "½" },
          { key: "1/3", value: "⅓" },
          { key: "2/3", value: "⅔" },
          { key: "1/4", value: "¼" },
          { key: "3/4", value: "¾" },
          { key: "1/8", value: "⅛" },
          { key: "3/8", value: "⅜" },
          { key: "5/8", value: "⅝" },
          { key: "7/8", value: "⅞" },
          // Units
          { key: "mm2", value: "mm²" },
          { key: "cm2", value: "cm²" },
          { key: "m2", value: "m²" },
          { key: "km2", value: "km²" },
          { key: "mm3", value: "mm³" },
          { key: "cm3", value: "cm³" },
          { key: "ccm", value: "cm³" },
          { key: "m3", value: "m³" },
          { key: "km3", value: "km³" },
          { key: ":sup2:", value: "²" },
          { key: ":sup3:", value: "³" },
          { key: ":deg:", value: "°" },
          // Currencies
          { key: ":eur", value: "€" },
          { key: ":gbp", value: "£" },
          { key: ":yen", value: "¥" },
          { key: ":cent", value: "¢" },
          { key: ":inr:", value: "₹" },
          // Special symbols
          { key: "(c)", value: "©" },
          { key: "(tm)", value: "™" },
          { key: "(r)", value: "®" },
          // Interpunctation
          { key: "...", value: "…" },
          { key: "--", value: "–" },
          { key: "---", value: "—" },
        ],
        matchWholeWords: false, // Whether to only autocorrect entire words, not parts
      }, // END autoCorrect options
    },
    display: {
      theme: "berlin", // The theme, can be berlin|frankfurt|bielefeld|karl-marx-stadt|bordeaux
      hideToolbarInDistractionFree: false,
      markdownFileExtensions: false,
      previewModeShowSyntaxWhenCursorIsAdjacent: true,
      imageWidth: 100, // Maximum preview image width
      imageHeight: 50, // Maximum preview image height
      renderingMode: "preview",
      renderCitations: true,
      renderIframes: true,
      renderImages: true,
      renderLinks: true,
      renderMath: true,
      renderTasks: true,
      renderHTags: true,
      renderEmphasis: true,
      renderPandoc: true,
      renderHorizontalRules: true,
    },
    files: {
      builtin: {
        showInFilemanager: true,
        showInSidebar: false,
        openWith: "zettlr",
      },
      images: {
        showInFilemanager: false,
        showInSidebar: true,
        openWith: "system",
      },
      pdf: {
        showInFilemanager: false,
        showInSidebar: true,
        openWith: "system",
      },
      msoffice: {
        showInFilemanager: false,
        showInSidebar: true,
        openWith: "system",
      },
      openOffice: {
        showInFilemanager: false,
        showInSidebar: true,
        openWith: "system",
      },
      dataFiles: {
        showInFilemanager: false,
        showInSidebar: true,
        openWith: "system",
      },
      dotFiles: {
        showInFilemanager: false,
        showInSidebar: false,
        openWith: "system",
      },
    },
    // Language
    selectedDicts: [], // By default no spell checking is active to speed up first start.
    appLang: locale,
    debug: false,
    watchdog: {
      activatePolling: false, // Set to true to enable polling in chokidar
      stabilityThreshold: 1000, // Positive int in milliseconds
    },
    system: {
      deleteOnFail: false, // Whether to delete files if trashing them fails
      leaveAppRunning: false, // Whether to leave app running in the notification area (tray)
      avoidNewTabs: false, // Whether to avoid opening new tabs for documents if possible
      iframeWhitelist: ["www.youtube.com", "player.vimeo.com"], // Contains a list of whitelisted iFrame prerendering domains
      checkForUpdates: true,
      zoomBehavior: "gui", // Used to determine what gets zoomed: The GUI or the editor
    },
    checkForBeta: false, // Should the user be notified of beta releases?
    displayToolbarButtons: {
      showOpenPreferencesButton: true,
      showNewFileButton: true,
      showPreviousFileButton: true,
      showNextFileButton: true,
      showPandocDivSpanButton: true,
      showMarkdownCommentButton: true,
      showMarkdownLinkButton: true,
      showMarkdownImageButton: true,
      showMarkdownMakeTaskListButton: true,
      showInsertTableButton: true,
      showInsertFootnoteButton: true,
      showDocumentInfoText: true,
      showPomodoroButton: true,
    },
    uuid: uuid4(), // The app's unique anonymous identifier
    // Agent API HTTP server (OpenAPI / REST) — spec: Zettlr-Pandoc Editor Agent API
    agentApi: {
      enabled: true,
      port: 27412,
    },
    references: {
      authorityReportDebounceMs: 500,
    },
  };
}
