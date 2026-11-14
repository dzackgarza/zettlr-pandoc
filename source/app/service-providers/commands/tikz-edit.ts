/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikzEdit command
 * CVM-Role:        Controller
 * License:         GNU GPL v3
 *
 * Description:     Opens one diagram of a document in the installed Visual
 *                  TikZ Editor and sends each save of that editor to the
 *                  windows on the `tikz-edit` channel. The editor is a
 *                  separate application; this command owns only its launch.
 *
 * END HEADER
 */

import path from "node:path";
import { trans } from "@common/i18n-main";
import broadcastIpcMessage from "@common/util/broadcast-ipc-message";
import { rawTikzInput } from "@common/util/tikz-source-blocks";
import { app } from "electron";
import { type AppServiceContainer } from "../../app-service-container";
import { canonicalMathJaxMacrosPath } from "../../util/load-mathjax-macros";
import { type TikzEditOpenOutcome, TikzEditSessions } from "../../util/tikz-edit-session";
import ZettlrCommand from "./zettlr-command";

export interface TikzEditOpenRequest {
  /** The session id, chosen by the window that holds the diagram. */
  id: string;
  /** The path of the Markdown document; "" for a buffer without a file. */
  docPath: string;
  language: "tikz" | "tikzcd";
  /** The authored source of the diagram, as the document holds it. */
  source: string;
}

export type TikzEditOutcome =
  | TikzEditOpenOutcome
  /** The diagram is a file that the document reads with \input; the editor saves to that file. */
  | { outcome: "file-opened" }
  /** An \input path of a buffer without a file names no file. */
  | { outcome: "document-unsaved" };

/** What the main process sends on the `tikz-edit` channel. */
export type TikzEditEvent =
  | { type: "source"; id: string; source: string }
  | { type: "ended"; id: string; code: number | null };

export default class TikzEdit extends ZettlrCommand {
  private readonly sessions = new TikzEditSessions({
    source: (id, source) => {
      broadcastIpcMessage("tikz-edit", { type: "source", id, source } satisfies TikzEditEvent);
    },
    ended: (id, code) => {
      broadcastIpcMessage("tikz-edit", { type: "ended", id, code } satisfies TikzEditEvent);
    },
  });

  constructor(app: AppServiceContainer) {
    super(app);
  }

  /** `tikz-edit-open` takes the diagram; `tikz-edit-close` takes the session id. */
  async run(_evt: string, arg: TikzEditOpenRequest | string): Promise<TikzEditOutcome | undefined> {
    if (typeof arg === "string") {
      this.close(arg);
      return undefined;
    }
    return await this.open(arg);
  }

  /** Stops the editor of the session with the id. */
  close(id: string): void {
    this.sessions.close(id);
  }

  /** Starts the external editor on one diagram. */
  async open(arg: TikzEditOpenRequest): Promise<TikzEditOutcome> {
    const context = {
      editorCommand: this._app.config.get().tikz.visualEditorCommand,
      macrosPath: canonicalMathJaxMacrosPath(app.getPath("home")),
      resourcesDirectory: arg.docPath === "" ? "" : path.dirname(arg.docPath),
    };
    const input = rawTikzInput(arg.source);
    if (input !== null && arg.docPath === "") {
      return { outcome: "document-unsaved" };
    }
    const outcome =
      input === null
        ? await this.sessions.openSource(arg.id, arg.source, arg.language, context)
        : await this.sessions.openFile(
            arg.id,
            path.resolve(context.resourcesDirectory, input),
            context,
          );

    if (outcome.outcome === "editor-missing") {
      this._app.windows.showErrorMessage(
        trans("Visual TikZ Editor is not installed"),
        trans(
          "The command %s is not on the PATH of this app. Install Visual TikZ Editor with its installer (just install-desktop).",
          outcome.command,
        ),
      );
    } else if (outcome.outcome === "launch-failed") {
      this._app.windows.showErrorMessage(
        trans("Visual TikZ Editor did not start"),
        trans("The system refused to start the editor: %s", outcome.code),
      );
    }
    return input !== null && outcome.outcome === "opened" ? { outcome: "file-opened" } : outcome;
  }

  async shutdown(): Promise<void> {
    await this.sessions.shutdown();
  }
}
