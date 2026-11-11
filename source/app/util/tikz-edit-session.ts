/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikZ edit sessions
 * CVM-Role:        Utility
 * License:         GNU GPL v3
 *
 * Description:     Starts the installed Visual TikZ Editor on one diagram of a
 *                  Markdown document. A diagram that is text of the document
 *                  becomes a file in a session directory; each save of the
 *                  editor to that file is reported as the new source of the
 *                  diagram. A diagram that the document reads with \input
 *                  opens as its own file. Every editor that this module
 *                  started stops with its session.
 *
 * END HEADER
 */

import { type ChildProcess, spawn } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** The editor saves with one write; this delay lets that write finish. */
const SAVE_SETTLE_MS = 50;

/**
 * The time that an editor has to end after SIGTERM. An editor that still
 * runs then ends on SIGKILL, which no process can ignore: the stop of a
 * session and the exit of the app have a time limit, as a stopped systemd
 * unit has (`TimeoutStopSec=`, then `SIGKILL` to the control group:
 * https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html).
 */
const KILL_GRACE_MS = 2_000;

export interface TikzEditContext {
  /** The command that starts the editor: a name on the PATH of the app, or a path. */
  editorCommand: string;
  /** The MathJax macro projection that the editor's Quiver view uses. */
  macrosPath: string;
  /** The directory from which image paths and TeX inputs resolve; "" for none. */
  resourcesDirectory: string;
}

export type TikzEditOpenOutcome =
  | { outcome: "opened"; id: string }
  | { outcome: "editor-missing"; command: string }
  | { outcome: "launch-failed"; code: string };

export interface TikzEditListener {
  /** The editor saved `source` as the diagram of session `id`. */
  source: (id: string, source: string) => void;
  /** The editor of session `id` stopped; `code` is its exit code, null after a signal. */
  ended: (id: string, code: number | null) => void;
}

interface Session {
  child: ChildProcess;
  stopped: Promise<void>;
  running: boolean;
  /** Set when the editor was told to stop: ends the editor that still runs. */
  kill: NodeJS.Timeout | undefined;
}

export class TikzEditSessions {
  private readonly sessions = new Map<string, Session>();
  private listening = true;

  constructor(private readonly listener: TikzEditListener) {}

  /**
   * Open `source` in the editor as session `id`. The session lasts until the
   * editor stops or `close` ends it.
   */
  async openSource(
    id: string,
    source: string,
    language: "tikz" | "tikzcd",
    context: TikzEditContext,
  ): Promise<TikzEditOpenOutcome> {
    const directory = await mkdtemp(path.join(tmpdir(), "zettlr-tikz-edit-"));
    const file = path.join(directory, language === "tikzcd" ? "diagram.tikzcd" : "diagram.tikz");
    await writeFile(file, source, "utf8");
    // The editor restores its last diagram from its state directory. A state
    // directory of the session keeps that record apart from the user's own.
    const stateHome = path.join(directory, "state");
    await mkdir(stateHome);

    let exchanged = source;
    let settle: NodeJS.Timeout | undefined;
    const watcher: FSWatcher = watch(directory, (_event, name) => {
      if (name !== path.basename(file)) {
        return;
      }
      clearTimeout(settle);
      settle = setTimeout(() => {
        void readFile(file, "utf8").then((saved) => {
          if (saved !== exchanged && this.listening && this.sessions.has(id)) {
            exchanged = saved;
            this.listener.source(id, saved);
          }
        });
      }, SAVE_SETTLE_MS);
    });
    const release = async (): Promise<void> => {
      clearTimeout(settle);
      watcher.close();
      await rm(directory, { recursive: true, force: true });
    };

    const outcome = await this.start(id, file, context, { XDG_STATE_HOME: stateHome }, release);
    if (outcome.outcome !== "opened") {
      await release();
    }
    return outcome;
  }

  /** Open a diagram file of the user in the editor. The editor saves to that file. */
  async openFile(id: string, file: string, context: TikzEditContext): Promise<TikzEditOpenOutcome> {
    return await this.start(id, file, context, {}, async () => {});
  }

  private async start(
    id: string,
    file: string,
    context: TikzEditContext,
    environment: Record<string, string>,
    release: () => Promise<void>,
  ): Promise<TikzEditOpenOutcome> {
    const resources =
      context.resourcesDirectory === "" ? [] : ["--resources", context.resourcesDirectory];
    // The editor is a process group of its own: its window process starts a
    // file host, and one signal to the group stops both.
    const child = spawn(
      context.editorCommand,
      ["--macros", context.macrosPath, ...resources, file],
      { detached: true, stdio: "ignore", env: { ...process.env, ...environment } },
    );
    const failure = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      child.once("spawn", () => {
        resolve(null);
      });
      child.once("error", resolve);
    });
    if (failure !== null) {
      return failure.code === "ENOENT"
        ? { outcome: "editor-missing", command: context.editorCommand }
        : { outcome: "launch-failed", code: failure.code ?? failure.message };
    }

    const session: Session = {
      child,
      running: true,
      kill: undefined,
      stopped: new Promise<void>((resolve) => {
        child.once("exit", (code) => {
          session.running = false;
          clearTimeout(session.kill);
          this.sessions.delete(id);
          void release().then(() => {
            if (this.listening) {
              this.listener.ended(id, code);
            }
            resolve();
          });
        });
      }),
    };
    this.sessions.set(id, session);
    return { outcome: "opened", id };
  }

  /**
   * Stop the editor of session `id`. A session that already ended, or that
   * was already told to stop, is left alone. An editor that still runs after
   * `KILL_GRACE_MS` ends on SIGKILL.
   */
  close(id: string): void {
    const session = this.sessions.get(id);
    if (session?.running !== true || session.child.pid === undefined) {
      return;
    }
    if (session.kill !== undefined) {
      return;
    }
    // While the editor runs, its process id is the id of its process group,
    // and the system gives that id to no other process.
    const group = -session.child.pid;
    process.kill(group, "SIGTERM");
    session.kill = setTimeout(() => {
      if (session.running) {
        process.kill(group, "SIGKILL");
      }
    }, KILL_GRACE_MS);
  }

  /**
   * Stop every editor and wait until each one is gone. The wait has a limit:
   * `close` ends an editor that does not end on SIGTERM.
   */
  async shutdown(): Promise<void> {
    this.listening = false;
    const sessions = [...this.sessions.entries()];
    for (const [id] of sessions) {
      this.close(id);
    }
    await Promise.all(sessions.map(async ([, session]) => await session.stopped));
  }
}
