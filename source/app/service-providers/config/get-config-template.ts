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

import {
  createShortcutConfig,
  type EditorCommandId,
  type WindowCommandId,
} from "@common/commands/command-registry";
import { MD_EXT } from "@common/util/file-extention-checks";
import getLanguageFile from "@common/util/get-language-file";
import type { SidebarSectionId, SidebarViewId } from "@dts/common/sidebar-views";
import * as bcp47 from "bcp-47";
import { app, nativeTheme } from "electron";
import path from "path";
import type { Get, Paths } from "type-fest";
import { v4 as uuid4 } from "uuid";
import AUTOCORRECT_REPLACEMENTS from "./autocorrect-replacements.json";

export type MarkdownTheme = "berlin" | "frankfurt" | "bielefeld" | "karl-marx-stadt" | "bordeaux";
export const DEFAULT_FILE_FILTER_INCLUDE = [...MD_EXT];

// This type adds groups of file types to the settings in
// order to allow users to display them in the file tree, and open them
// internally or externally.
// NOTE: The generics are meant so that you can restrict certain groupings.
// E.g., FileTypeSettings<true, 'zettlr'> enforces these values for the two
// properties.
type FileTypeSettings<F = boolean, O = "zettlr" | "system"> = { showInFilemanager: F; openWith: O };

export type ConfigurableEditorShortcuts = EditorCommandId;
export type ConfigurableUIShortcuts = WindowCommandId;

/**
 * This type describes an entry of the ignored rules array in the config. We
 * define this type here, and not in the LanguageTool command, because if we
 * change its structure, bad things could happen. By colocating it with the
 * config, it is harder for us to forget to write a migration rule if we ever
 * change this structure.
 */
export type LanguageToolIgnoredRuleEntry = {
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
};

export type AgentApiConfig = {
  enabled: boolean;
  /**
   * Loopback port for the HTTP listener. `0` requests a kernel-assigned port.
   * In every case the actual bound port is published to the `agent-api.port`
   * file in the user-data directory once the listener is up.
   */
  port: number;
  /**
   * Normalized Levenshtein similarity (0–1) at or above which two claims in
   * one review submission count as sharing a description, and the submission
   * is refused with DUPLICATE_CLAIM_DESCRIPTION.
   */
  claimDescriptionSimilarityThreshold: number;
  /**
   * Read-only root exposed by the Agent API skills endpoint. `null` disables
   * that capability. The endpoint accepts only physical descendants and `.md`
   * files under this directory.
   */
  skillsDirectory: string | null;
};

export type ReferenceConfig = { authorityReportDebounceMs: number };

export type ConfigOptions = {
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
    /** Expanded directory rows in the Explorer, persisted across restarts. */
    expandedDirectories: string[];
    /**
     * The ignore rules of every workspace, one gitignore line each. The app
     * lists no file or folder that a rule matches. Each workspace adds the
     * rules of the `.zettlrignore` file at its root.
     */
    ignoreRules: string[];
    /** Lists the files and folders that the ignore rules match. The rules stay. */
    showIgnored: boolean;
    /** The file types that the file manager and the file picker list. */
    filters: {
      include: string[];
    };
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
    /** Optional centralized figure source tree; empty uses FIGURES_SOURCE_DIR or ~/.pandoc/figures. */
    figuresDir: string;
  };
  export: {
    dir: "temp" | "cwd" | "ask";
    stripTags: boolean;
    autoOpenExportedFiles: boolean;
    enforceMarkSupport: boolean;
    stripLinks: "full" | "unlink" | "no";
    cslLibrary: string;
    cslStyle: string;
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
    autocompleteWithEnter: boolean;
    autocompleteWithTab: boolean;
    /** Portable VS Code `.code-snippets` source file. */
    snippetsFile: string;
    /** Portable prose-completion additions file; new entries are appended here. */
    proseCompletionFile: string;
    /** Additional portable prose-completion catalogues, read-only to Zettlr. */
    proseCompletionExtraFiles: string[];
    /** Optional QuickTeX Vimscript configuration file. */
    quickTexFile: string;
    /** QuickTeX plugin root whose runtime files Neovim should execute. */
    quickTexPluginDirectory: string;
    autoSave: "off" | "immediately" | "delayed";
    // Run flowmark over the document on every save (issue #26). Off by default.
    formatOnSave: boolean;
    /** How long one flowmark format run may take before it is reported as timed out. */
    formatTimeoutMs: number;
    citeStyle: "in-text" | "in-text-suffix" | "regular";
    autoCloseBrackets: boolean;
    showLinkPreviews: boolean;
    showWhitespace: boolean;
    showMarkdownLineNumbers: boolean;
    defaultSaveImagePath: string;
    enableTableHelper: boolean;
    indentUnit: number;
    indentWithTabs: boolean;
    alwaysIndentLineOnTab: boolean;
    fontSize: number;
    countChars: boolean;
    inputMode: "default" | "vim" | "emacs";
    boldFormatting: "**" | "__";
    italicFormatting: "_" | "*";
    highlightFormatting: "span" | "==";
    readabilityAlgorithm: "dale-chall" | "gunning-fog" | "coleman-liau" | "automated-readability";
    lint: {
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
        provider: "cli" | "official" | "custom";
        customServer: string;
        username: string;
        apiKey: string;
      };
      flowmark: {
        /** How long one flowmark-lint run may take before it is reported as timed out. */
        timeoutMs: number;
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
    builtin: FileTypeSettings<true, "zettlr">;
    // Images and PDFs can be entirely hidden or shown everywhere, and opened
    // with the system default, or in Zettlr
    images: FileTypeSettings;
    pdf: FileTypeSettings;
    // These file types can be shown anywhere, but are not open-able by Zettlr.
    msoffice: FileTypeSettings<boolean, "system">;
    openOffice: FileTypeSettings<boolean, "system">;
    dataFiles: FileTypeSettings<boolean, "system">;
    dotFiles: FileTypeSettings;
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
    recentGlobalSearches: string[];
  };
  ui: {
    /** The navigation sidebar's width in pixels, as last dragged. */
    navigationSidebarWidth: number;
    /** The annotation review panel's width in pixels, as last dragged. */
    annotationPanelWidth: number;
    /** The view the sidebar's drawer shows: one per activity-bar icon. */
    sidebarView: SidebarViewId;
    /** The sidebar sections the user collapsed; the rest are expanded. */
    sidebarCollapsedSections: SidebarSectionId[];
    /** How many files the launcher's recently opened and recently edited lists each keep. */
    recentFilesLimit: number;
  };
  system: {
    deleteOnFail: boolean;
    leaveAppRunning: boolean;
    avoidNewTabs: boolean;
    iframeWhitelist: string[];
    checkForUpdates: boolean;
    zoomBehavior: "gui" | "editor";
  };
  shortcuts: {
    editor: Record<string, string>;
    ui: Record<string, string>;
  };
};

/**
 * The dotted path of one option, for example `editor.indentUnit`.
 */
export type ConfigPath = Paths<ConfigOptions>;

/**
 * The type of the option at a dotted path.
 */
export type ConfigValue<P extends ConfigPath> = Get<ConfigOptions, P>;

/**
 * The installed translation that best matches the system locale, or en-US
 * when the system locale is not a language tag.
 */
export function systemAppLang(): string {
  const locale = app.getLocale();
  // bcp-47 sets the language to null for a tag that it cannot parse.
  const language = bcp47.parse(locale).language;
  if (language === null || language === undefined) {
    return "en-US";
  }
  return getLanguageFile(locale).tag;
}

/**
 * The default configuration. The caller resolves the interface language,
 * because that reads the installed translations.
 */
export function getConfigTemplate(appLang: string): ConfigOptions {
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
      figuresDir: "",
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
      recentGlobalSearches: [],
    },
    ui: {
      navigationSidebarWidth: 280,
      annotationPanelWidth: 320,
      sidebarView: "explorer",
      // Outline, Book and Related files open on demand under their view's body.
      sidebarCollapsedSections: ["outline", "book", "relatedFiles"],
      recentFilesLimit: 50,
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
      expandedDirectories: [],
      ignoreRules: [],
      showIgnored: false,
      filters: {
        include: [...DEFAULT_FILE_FILTER_INCLUDE],
      },
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
      exportQmdWithQuarto: false, // Whether .qmd-files should be exported with Quarto
      customCommands: [], // Custom commands that the user can use to run arbitrary exports
      filters: [], // Ordered Pandoc filters applied to every export (resolved from ~/.pandoc/filters)
      injectMathHeaders: true, // Inject local MathJax config/preamble into exports; off defers to the profile template
      htmlTemplate: "", // Default Pandoc template for HTML/revealjs exports (when the profile declares none)
      latexTemplate: "", // Default Pandoc template for latex/pdf/beamer exports (when the profile declares none)
      scripts: [],
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
      formatTimeoutMs: 300_000,
      autocompleteSuggestEmojis: true,
      autocompleteWithEnter: false,
      autocompleteWithTab: true,
      snippetsFile: path.join(app.getPath("home"), ".pandoc", "snippets", "snippets.code-snippets"),
      proseCompletionFile: path.join(app.getPath("home"), ".pandoc", "completions", "prose.txt"),
      proseCompletionExtraFiles: [],
      quickTexFile: "",
      quickTexPluginDirectory: "",
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
      inputMode: "default", // Can be default, vim, emacs
      boldFormatting: "**", // Can be ** or __
      italicFormatting: "_", // Can be * or _
      highlightFormatting: "==", // Can be 'span' or ==
      readabilityAlgorithm: "dale-chall", // The algorithm to use with readability mode.
      lint: {
        languageTool: {
          active: false, // Utilize languageTool?
          level: "default", // API: https://languagetool.org/http-api/#!/default/post_check
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
          provider: "cli",
          customServer: "",
          username: "",
          apiKey: "",
        },
        flowmark: {
          timeoutMs: 60_000,
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
        replacements: structuredClone(AUTOCORRECT_REPLACEMENTS),
        matchWholeWords: false, // Whether to only autocorrect entire words, not parts
      }, // END autoCorrect options
    },
    display: {
      theme: "berlin", // The theme, can be berlin|frankfurt|bielefeld|karl-marx-stadt|bordeaux
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
        openWith: "zettlr",
      },
      images: {
        showInFilemanager: true,
        openWith: "system",
      },
      pdf: {
        showInFilemanager: true,
        openWith: "system",
      },
      msoffice: {
        showInFilemanager: true,
        openWith: "system",
      },
      openOffice: {
        showInFilemanager: true,
        openWith: "system",
      },
      dataFiles: {
        showInFilemanager: true,
        openWith: "system",
      },
      dotFiles: {
        showInFilemanager: false,
        openWith: "system",
      },
    },
    // Language
    selectedDicts: [], // By default no spell checking is active to speed up first start.
    appLang,
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
    shortcuts: createShortcutConfig(),
    uuid: uuid4(), // The app's unique anonymous identifier
    // Agent API HTTP server (OpenAPI / REST) — spec: Zettlr-Pandoc Editor Agent API
    agentApi: {
      enabled: true,
      port: 27412,
      claimDescriptionSimilarityThreshold: 0.94,
      skillsDirectory: null,
    },
    references: {
      authorityReportDebounceMs: 500,
    },
  };
}
