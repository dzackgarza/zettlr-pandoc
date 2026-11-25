# 30. The QuickTeX configuration

- **Neovim evaluates the configuration.** `loadQuickTex`
  (`app/util/load-quicktex.ts`) sources the QuickTeX plugin of
  `editor.quickTexPluginDirectory` and the Vimscript file of
  `editor.quickTexFile` in Neovim and reads the two dictionaries. The app
  parses no Vimscript. No file setting is no configuration.
- **A configuration that the app cannot use is a problem, not a stop.**
  `AssetsProvider.readQuickTex` gives a catalogue without expansions and one
  `QuickTexProblem` (`types/common/quicktex.ts`): the setting, the value
  that the provider read, and the cause. A file that cannot be read and a
  Neovim run that fails are problems of `editor.quickTexFile`. A plugin
  directory without `plugin/quicktex.vim` and a configuration without a
  plugin directory are problems of `editor.quickTexPluginDirectory`.
- **Each window shows the problem at its setting.** A window follows the
  problem through `followQuickTexProblem`
  (`common/util/quicktex-problem.ts`). The main window shows it one time as
  an error with the action "Open Preferences" (`showQuickTexProblem`). The
  Preferences window marks the field of the setting while the field holds
  the value that the provider read (`getSnippetsFields`).
- **A problem of a setting is shown one time while it stands.**
  `showStandingProblems` (`win-main/util/standing-problem-toasts.ts`) owns
  that rule for the citation problems ([§12](citations.md)) and the QuickTeX problem. A new
  provider whose setting names a file that it cannot load shows the problem
  through it.
- **Proof:** `e2e/quicktex-unavailable.spec.ts`.
