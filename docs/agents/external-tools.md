# 25. Runs of external tools

- **One owner.** `packages/external-process` (`@dzack/external-process`)
  runs each external tool of the main process: `runProcess`
  (`src/run-process.ts`) and `probeTool` (`src/probe-tool.ts`). It imports
  nothing from `source/`. See `packages/external-process/README.md`.
- **Each run has the same rules.** A run leads a process group of its own. A
  time limit stops the group with SIGTERM and then SIGKILL; a run that a
  signal ends leaves no process of its group; the exit of the app stops each
  run. The answer is an outcome (`exit`, `signal`, `timeout`, `not-started`),
  never a rejection for the program's end. A failed start names its cause:
  the program is absent, is not executable, or its working folder cannot be
  used. `describeOutcome` gives the sentence; `requireExit` and
  `requireSuccess` throw it for a caller whose work stops there.
- **The callers.** The TikZ render, Flowmark, Pandoc of the export, the
  import and the citation reader (`runPandoc`, `pandoc-citations.ts`),
  `latexpand`, the PDF recipe, the shell commands of the author
  (`runShellCommand`: the command is shell text, each path an argument),
  the justfile listing, the QuickTeX loader, the tray check and
  `notify-send`. A new run of a tool goes through `runProcess`; a new check
  that a tool is installed goes through `probeTool`.
- **A start of an application is not a run.** `openPath`, the kitty
  launcher, the PDF viewer of a link and the Visual TikZ Editor start a
  program that goes on after the app has its answer; they keep their own
  `spawn`.
- **Proof:** `packages/external-process/test/run-process.spec.ts`,
  `test/start-tool-probes.spec.ts`, `test/preflight.spec.ts`,
  `test/run-shell-command.spec.ts`.
