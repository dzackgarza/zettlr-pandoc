# The desktop launcher

`scripts/desktop/zettlr-pandoc-boot` builds and starts Zettlr-Pandoc from the
repository behind the installed launcher symlink. It runs in the kitty splash
terminal. The start is ready only when the app reports a completed boot.

## The steps of a start

1. **One start at a time.** The script holds the lock
   `~/.cache/zettlr-pandoc-launch.lock` while it selects the build and writes
   the log of the start. The app does not inherit the lock descriptor.
2. **The profile of the start** is the folder of `--data-dir` (relative to
   the folder of the binary, as `source/main.ts` resolves it for a packaged
   app), else the `userData` folder of Electron:
   `${XDG_CONFIG_HOME:-~/.config}/Zettlr-Pandoc`.
3. **An app already runs** when it holds the single-instance lock of that
   profile. Chromium's ProcessSingleton (`process_singleton_posix.cc`) keeps
   the lock as the symbolic link `SingletonLock -> <hostname>-<pid>`. A link
   of another host or of a process that is gone is a stale lock, which the
   next start takes over. A window of the class `zettlr-pandoc` does not
   decide: an app of another profile has the same class.
4. **The MathJax macros are made again** before a start that finds no
   running app: `scripts/desktop/zettlr-pandoc-refresh-macros` runs the
   recipe `generate-math-macros` of `~/.pandoc/justfile`. The recipe runs the
   generator in the project environment of `pandoc-config`
   (`uv run --project`), which holds pylatexenc. The system `python3` does
   not have it. A failed refresh stops the start. Proof:
   `test/desktop-macro-refresh.spec.ts`.
5. **The build.** The packaged build in `out/` has a stamp of the source
   fingerprint that it was built from (`.source-fingerprint`). A stamp equal
   to the fingerprint of the tree means that no commit, tracked edit or
   untracked file changed since the build: the script starts the binary as
   it is. Another stamp, or no build, starts `just package`, which takes the
   fingerprint before the build, so an edit during the build is stale at the
   next start. The launcher sets `ZETTLR_LOCAL_PACKAGE=1`: the build is a
   local artifact, not a release, and it does not minify the JavaScript of
   the 14 renderer entry points. `just launch-desktop` is the development
   start with hot reload.
6. **The environment.** A desktop entry has no shell environment, and an app
   with an enabled Agent API and no token does not start. The script starts
   the binary under `direnv exec "$HOME"`, so the app gets the variables of
   `~/.envrc`, the one home of the token, and no other process gets them.
   The script stops when `~/.envrc` is absent.
7. **The debug port.** A first start opens `--remote-debugging-port=27413`.
   A start that delivers its arguments to a running app opens no port: the
   running app holds it.

## The wait for the window

- The app is up when its stdout has `[Application] Boot complete.` or
  `[Application] Launch complete.` (`source/main.ts`) and Hyprland shows a
  window of its class. The window alone does not decide: the fatal error
  dialog of Electron has the same class.
- A `hyprctl` failure stops the script with its message. It is not "the app
  is not up yet": a script that waits on it waits until the time limit and
  then names the app as the cause.
- A process probe with signal 0 fails for two causes: the process is gone,
  or the probe was refused (`EPERM`). Only "No such process" means gone; the
  probe runs with `LC_ALL=C`, so that text is not translated. Each other
  answer stops the script.
- The time limit is 300 s for a start without a build and 660 s for a start
  with one. The build has its own limit of 600 s (`BUILD_TIMEOUT_S` of
  `scripts/verify-build.py`), and the wait is longer than it: a splash that
  stops first leaves a build that still works.
- At the time limit the script ends the process group of the start, which
  runs detached. A `just package` that still ran would otherwise start the
  app after the splash closed (2026-08-14: a window that held a removed
  `$HOME`). "No such process" is the one accepted failure of that stop.
- The splash closes when the script returns, so a failure shows the last 20
  lines of the log and waits for a key.

## Proof

- `test/desktop-macro-refresh.spec.ts` runs the macro refresh of a start
  with a home whose `.pandoc` is a local clone of the real one, without a
  virtual environment of the caller.
- `e2e/desktop/installed-launcher-delivery.spec.ts` (#52) is the proof of
  the whole chain: the desktop entry starts `zettlr-pandoc-dev`, which opens
  the splash, which runs `zettlr-pandoc-boot`. A start without a running app
  starts the packaged binary; a start with one gives the files to
  `zettlr-pandoc-open-in-running`. The spec starts each delivery from the
  installed desktop entry through `gio launch`, as a desktop session does.
  - Only `$HOME` is isolated: the spec installs the launcher there and links
    the real `~/.pandoc` into it. `XDG_RUNTIME_DIR` stays, because Wayland
    and Hyprland need it, and a token of the shell of the run does not reach
    the app.
  - Hyprland is global to the session, so the spec needs a live Hyprland
    and no other running Zettlr-Pandoc. It fails at the start without them;
    a simulated start would be no proof of the chain.
  - `gio launch` returns when the whole chain exits, which the boot script
    does after the app booted and its window is up. A boot failure keeps the
    splash open, so the test ends at its time limit; the spec then shows the
    stderr of the chain (a splash that did not open) and the launcher log
    (a failed build or start).
  - A delivered file is the focused document with its bytes; a second
    delivery reaches the same process, and the desktop shows one window.
  - At the end the spec ends the process group of the app, then kills it,
    and fails when the window stays.
  - The workstation runs it with `just test-e2e-desktop`; it is no job of
    the hosted run.
