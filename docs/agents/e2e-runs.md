# 13. Assembled-app E2E runs

- **A window error fails its spec file.** The lanes runner loads
  `e2e/support/root-hooks.ts` before each spec file (`--file`). `attach` puts
  the windows of each app that a file starts under the gate of that file: a
  console error, an uncaught exception or a dialog that no test of the file
  provokes fails the file in the last hook of the root suite, with the
  events in the message. A spec needs no line for this, and a spec that gives
  `attach` a new array is under the gate too. A spec of a failure declares
  the message that it causes with `provokesRendererEvents(/…/)`; a pattern
  names that one message, never a class of errors. A console error of a
  resource that did not load names the resource.
- **A failed test keeps its windows.** The hook after each test takes a
  screenshot of each open window when the test failed; `preserveArtifacts`
  writes them as `failure-<test>-window-<n>.png` with `failures.txt`.
- **A spec that connects itself is under the gate too.** `observeRenderer`
  puts the array of its first page under the gate, and `observeBrowser`
  observes each window of a connection: a spec that calls
  `chromium.connectOverCDP` itself calls one of them for its connection.
- **Each file keeps what its failed tests showed.** A spec that calls
  `preserveArtifacts` gets the screenshots, `failures.txt` and, when a test
  failed, the whole fixture (`fixture/`: the configuration, the workspace,
  the logs) in its artifacts. A file that keeps no artifacts itself gets
  `/tmp/zettlr-<file>-failures-e2e-latest` from the root hooks. The hosted
  run uploads `/tmp/zettlr-*-e2e-latest`.
- **No exclusive and no skipped test passes.** mocha runs with
  `--forbid-only` in the lanes runner and in `scripts/run-unit-tests.sh`,
  and with `--forbid-pending` and `--fail-zero` in the lanes runner: a file
  with `.only`, with a skipped test, with a test without a body or with no
  test fails, and so does a file name that names no file. Proof of these
  rules: `test/e2e-run-lanes.spec.ts`.
- `just test-e2e` and `just test-e2e-file <spec>` run the specs of `e2e/`.
  The recipes first make the packaged build of the tree when it is not
  current (`_current-package`: `verify-build.py --if-stale`), one build for
  the run. A spec that starts the app through `attach`
  (`e2e/support/electron-app.ts`) runs the archive of that build
  (`currentPackagedArchive`) with the Electron of `node_modules`: the start
  compiles nothing, and it has 60 s (`startDeadline`). A start with
  `buildEnvironment` (variables that webpack reads, such as
  `ZETTLR_DISABLE_UPDATE_CHECK`) compiles a development build of its own
  through `electron-forge start` and has 240 s. A webpack cache does not
  make that faster: a build from the cache lost the nodehun asset (#70).
  `e2e/application-lifecycle.spec.ts` and
  `e2e/citation-library-thread.spec.ts` start the packaged binary itself,
  which writes its log to a file; such a spec reads the shutdown line through
  `readAppLog`. Each path refuses a build whose source fingerprint is not
  that of the tree at the start of the run: the lanes runner reads it and
  gives it to each file (`E2E_SOURCE_FINGERPRINT`). A source edit or a
  commit during the run does not stop its later files.
- **Spec files run in lanes.** `e2e/support/run-lanes.ts` runs three spec
  files at the same time, each in a Mocha process of its own. A lane takes
  the next file when its file ends. The runner prints the output of a file
  whole when the file ends, then each file by time, the slowest first, and
  the wall time of the run (#70). A spec file holds no state that another
  file reads: its fixture is a temporary directory of its own, and the app
  binds port 0 (`readAgentApiPort`). A start that compiles the app
  (`buildEnvironment`) gives Forge the two ports of its lane
  (`forgePortsOfLane`, below the ephemeral range): Forge cannot bind port 0.
- **A test or a hook has 90 s** (`--timeout 90000` of `run-lanes.ts` and
  `test:e2e:desktop`): two times the slowest spec file
  of a hosted run (46 s), and more than one start of the packaged app. A
  suite whose test or hook starts the app more than one time sets its limit
  from those starts (`2 * startDeadline({}) + 60_000`); no suite sets a
  larger number without that reason (#70). `test-e2e-desktop` builds the
  package before the run too, so the boot script of the installed launcher
  starts the current build and does not package it in a test
  (`e2e/desktop/installed-launcher-delivery.spec.ts`).
- **A start has no WebGL without `softwareWebGL`.** A start of the harness
  turns hardware acceleration off. The start option `softwareWebGL`
  (`LaunchOptions`) gives the windows of one start the contexts of
  SwiftShader, the software renderer of Chromium.
- **A lane owns its display.** Each lane starts one Xvfb server
  (`-displayfd`) and runs its files with that `DISPLAY`, also when the
  environment has a display. A native message box, a key that `xdotool`
  presses and the focus of a window are therefore not shared between the
  files of two lanes. A spec starts no X server of its own.
- **The run owns its X socket folder.** The recipe (`_e2e-run`) mounts an
  empty tmpfs at `/tmp/.X11-unix` for the run. Xvfb removes the socket path
  of its display before it binds, and with `-displayfd` it takes display 0
  over the lock of a running server; in the folder of the host its exit
  removed the socket of the X server of the desktop, and no new X11 client
  connected to `:0`. Proof: `test/e2e-run-displays.spec.ts`.
- **The run owns its session bus.** The lanes runner starts one
  `dbus-daemon` with `scripts/e2e-session-bus.conf`, a bus without services,
  and gives its address to each spec file (`startSessionBus`,
  `e2e/support/run-lanes.ts`). A desktop notification of the app of a run
  goes to that bus and not to the desktop of the author. The stock session
  configuration starts a notification daemon on request, and that daemon
  draws on the compositor of the author. A spec that needs a session service
  starts it on the bus of the run. Proof: `test/e2e-run-lanes.spec.ts`.
- **No process of a run outlives its just process.** The runner is the one
  process of the recipe `_e2e-run`: the SIGTERM that just passes on (the
  stop of `timeout` and of a supervisor) is a signal of the runner, which
  ends its files. The kernel ends the runner with its just process, also
  after SIGKILL (`setpriv --pdeathsig KILL` in the recipe and in
  `e2e_lanes`), and each child of the runner with the runner. A program
  between just and the runner must pass each signal on and end its children
  with itself. `dbus-run-session` does neither: with it, a stopped run left
  its bus daemon, and its runner went on with the files. Proof:
  `test/e2e-run-lanes.spec.ts`.
- **The run owns its loopback.** The recipe (`_e2e-run`) starts the run in
  a network namespace with `lo` and no other interface. An app of the run
  binds the Agent API port, the Forge ports of a build start and each other
  port there, so
  the desktop app of the author on port 27412 takes no port from a first
  start of the run (#215). The run reaches no service of the host (Zotero)
  and no network: a spec that needs a service starts it in the run. On the
  hosted runner, `just setup-ci` permits the namespace
  (`kernel.apparmor_restrict_unprivileged_userns`). Proof:
  `test/e2e-run-loopback.spec.ts`.
- **A spec file owns its loopback and its processes.** The lanes runner
  starts the Mocha process of a file in namespaces of its own
  (`FILE_NAMESPACES`, `e2e/support/run-lanes.ts`), inside those of the run.
  The network namespace has `lo` and no other interface: a first start of
  the app (`startFirstRun`) has no configuration and binds the default Agent
  API port, and two such files in two lanes each bind it. The process
  namespace ends with the file, and the kernel ends each process that the
  file left: an app whose after hook failed takes no display and no memory
  from the next file. Mocha ends when the tests and the hooks of the file
  ended (`--exit`), so a handle that a file left holds no lane. A stop of
  the run ends each file and its processes with SIGKILL. A runner that
  SIGKILL ends runs no handler, and the time limit of a file is a timer of
  the runner: the runner starts each child (the file, the Xvfb server of a
  lane, the session bus) through `setpriv --pdeathsig KILL` (`ENDS_WITH_RUNNER`), so the
  kernel ends the child with the runner. A new child of the runner starts
  the same way. Proof: `test/e2e-run-lanes.spec.ts`.
- **Each wait of a run has a limit.** A test or a hook has its Mocha limit.
  A Mocha process ends with its last hook (`--exit` of the lanes runner,
  `exit` of `.mocharc.js` for the unit suite). A spec file of the lanes has
  180 s (`e2e_file_limit_seconds` of the justfile; the slowest file takes
  69 s): at the limit the runner ends the file with each of its processes
  and reports it as failed. Each job of the hosted run has 15 minutes and
  the assembled-app step of a shard 8 (`timeout-minutes`, `check.yml`). A
  new step or runner that waits for a process states the limit of that
  wait.
- **The hosted run is jobs that run at the same time.** `check.yml` has the
  job `unit` (the typecheck and the unit suite) and four jobs `e2e`, each
  with one shard of the spec files (`just test-e2e <index>/4`; the lanes
  runner sorts the files and deals them to the shards in turn). Each job
  sets up the toolchain through `.github/actions/setup-ci`, and each shard
  builds the package itself. The job `Unit Tests / Lint` is the check that
  the protection of `develop` requires: it passes when each other job
  passed. A new part of the hosted run is a job of its own that this job
  needs; a step that goes into a job adds its time to the run (#70). Proof
  of the shards: `test/e2e-run-lanes.spec.ts`.
- **A provider that cannot start is in the log before its error box.** The
  native box of `_informativeBoot` stops the main process, and the app exits
  after it; the log has the cause first (`LogProvider.flush`). Proof:
  `e2e/agent-api-port-in-use.spec.ts`.
- A Chromium probe of test-support code reports its exit code or signal, its
  output and the X server errors when it fails (`test/visual/display-probe.ts`).
- An e2e run and a `just package` build each need most of the memory of this
  workstation. Run one at a time. A start from the desktop launcher runs
  `just package` when the source changed, and the build replaces the package
  under a running e2e run: the next start of that run refuses the build of
  another fingerprint, or a running app stops with a closed page. Run it
  again after the build.
- **A click that closes its page goes through `clickToClose`.** Playwright
  stops each action of a page that closes before the action ends, so a click
  whose handler closes the window races the close. `clickToClose` and
  `requestWindowClose` (`e2e/support/electron-app.ts`) act in a later task
  of the page, as `requestQuit` does.
- **A function that runs in the page declares no named function.** tsx
  compiles a spec with esbuild's `keepNames`, which puts a call of the helper
  `__name` around each function that a `const` or a declaration names. The
  page has no such helper, so `page.evaluate` stops with `__name is not
  defined`. A callback that is an argument has no name and is not wrapped.
- **A native message box is not a page.** Playwright does not see it. A spec
  finds the box by its title with `xdotool`, captures it with ImageMagick
  `import`, and presses a key in it (`e2e/quit-with-open-review.spec.ts`). A
  start that shows a box keeps the programs of the system on its PATH: on
  the hosted image GTK loads the icon of a box through `bwrap`, and a start
  whose PATH has no `bwrap` aborts in GTK before the box shows. A spec that
  takes one command away replaces the directory that holds it by links to
  its other entries (`pathWithout`,
  `e2e/start-without-required-tool.spec.ts`). The
  CI toolchain installs both tools (`scripts/setup-ci-toolchain.sh`). Such a
  spec runs through the lanes only: a Mocha run on the display of the
  environment presses its keys on the desktop of the author.
- **A file dialog is drawn on the display of the run.** `attach` starts the
  app with `--xdg-portal-required-version` at a version that no portal has
  (`NO_PORTAL_FILE_CHOOSER_VERSION`). Without the option the desktop portal
  of the session draws the dialog on the desktop of the author. A spec
  accepts a GTK file chooser with the mnemonic of its button (`alt+s` for
  Save, `alt+o` for Open): the Return key does not accept it while the name
  field has the focus (`e2e/refused-save.spec.ts`). A dialog that opens in a
  folder of the fixture (`dialogPaths` of the configuration) shows no folder
  of the author (`e2e/import-files.spec.ts`).
- **A screenshot of a hover tooltip has no `clip`.** For a clipped
  screenshot Chromium moves the viewport, and the editor closes its hover
  tooltip. A spec takes the screenshot of the whole page
  (`e2e/chip-link-affordance.spec.ts`).
- **A role query has the surface as its root.** A row of the file tree
  outside the viewport computes no style (`content-visibility: auto`,
  `TreeItem.vue`). `getByRole` of a page asks each element for its
  visibility, and each such row then computes its style: 4 s for a folder of
  1,026 files on a workstation, and more than a wait of 10 s on a hosted
  runner. A spec of a window that shows the tree starts a role query at the
  locator of its surface (`page.locator(".popover").getByRole(...)`;
  `e2e/global-search-dispatch-failure.spec.ts`).
- **A spec assumes no time between two of its actions.** A hosted runner is
  about two times slower than a workstation, so two actions of a spec can be
  more than a debounce of the app apart, and an answer of the main process
  can arrive after the surface that shows it. A spec reads a list that an
  asynchronous source fills when the list holds the entry that it reads
  (`completionLabelsAfter`, `e2e/autocomplete-language-sources.spec.ts`). A
  spec does not count events that a timer of the app can add between two
  actions: the query field of the Search view starts a search 200 ms after a
  change of its text, and the Enter key starts one more
  (`e2e/global-search-dispatch-failure.spec.ts`).
- **A spec waits for the outcome in the window, and acts as an author
  acts.** Each spec that failed only on a busy machine had one of four
  shapes:
  - A wait that the state before the action satisfies. After a click on
    another tab, "an active tab" is true at once; the wait is for the
    clicked tab (`e2e/dirty-buffer-indicator.spec.ts`). A value of the main
    process is read when it exists, not when a tab is active
    (`e2e/move-with-unwritable-review-state.spec.ts`).
  - A fixed pause in the place of the outcome. A spec waits for the outcome
    up to its limit and then checks for a short time that it stays
    (`e2e/jump-to-heading-while-loading.spec.ts`).
  - `fill()` against a selection that the app makes after the field is
    visible. `fill()` selects all and then inserts; a selection of the app
    between the two steps makes the text replace only that selection. The
    spec waits for the focus and the selection that an author sees and
    types over it (`e2e/rename-one-field.spec.ts`).
  - An order that depends on the speed of the test process. An action that
    must follow an event of the window at once is made inside the page, in
    the handler of that event (`e2e/global-search-dispatch-failure.spec.ts`).

  A failure that has none of these shapes is a defect of the app until its
  cause says otherwise. A spec is not run many times to see whether it
  fails again: one run with its log kept is read for the cause.
- **Shared helpers.** `e2e/support/native-dialog.ts` finds, captures and
  answers a native window. `e2e/support/panes.ts` gives the panes of a
  window and opens a document in one.
