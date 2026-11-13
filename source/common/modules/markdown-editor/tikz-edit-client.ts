/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Visual TikZ Editor launch client
 * CVM-Role:        Controller
 * License:         GNU GPL v3
 *
 * Description:     The window side of an external edit: asks the main process
 *                  to start Visual TikZ Editor on one diagram of an editor
 *                  view, and takes the saves that the main process reports
 *                  into that view.
 *
 * END HEADER
 */

import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { trans } from "@common/i18n-renderer";
import { reportError } from "@common/util/error-reporting";
import showToast from "@common/util/show-toast";
import type { TikzEditEvent } from "source/app/service-providers/commands/tikz-edit";
import {
  beginTikzEditSession,
  endTikzEditSession,
  externalTikzSourceUpdate,
  type TikzEditSession,
  tikzEditSessionsField,
} from "./tikz-edit-sessions";

/** The name of every control that starts the external editor. */
export const EDIT_IN_VISUAL_TIKZ_EDITOR = "Edit in Visual TikZ Editor";

export interface TikzEditTarget {
  /** The authored range of the diagram in the document of `view`. */
  from: number;
  to: number;
  language: "tikz" | "tikzcd";
  /** The path of the document; "" for a buffer without a file. */
  docPath: string;
}

/**
 * Start Visual TikZ Editor on the diagram at `target`. A diagram that the
 * editor already has open starts no second editor.
 */
export async function editTikzInVisualEditor(
  view: EditorView,
  target: TikzEditTarget,
): Promise<void> {
  const open = view.state
    .field(tikzEditSessionsField)
    .some((session) => session.from === target.from && session.to === target.to);
  if (open) {
    showToast(trans("Visual TikZ Editor already has this diagram open."), "info", 6000);
    return;
  }

  // The session starts before the editor does, so the range follows the text
  // that the author types while the editor starts.
  const id = crypto.randomUUID();
  view.dispatch({ effects: beginTikzEditSession.of({ id, from: target.from, to: target.to }) });
  const result = await window.ipc
    .invoke("application", {
      command: "tikz-edit-open",
      payload: {
        id,
        docPath: target.docPath,
        language: target.language,
        source: view.state.sliceDoc(target.from, target.to),
      },
    })
    .catch((error: Error) => {
      // A command that failed started no editor, so there is no session.
      view.dispatch({ effects: endTikzEditSession.of(id) });
      throw error;
    });
  if (result.outcome === "opened") {
    return;
  }
  // Without a running editor on this source there is no session. The main
  // process showed the reason when the editor did not start.
  view.dispatch({ effects: endTikzEditSession.of(id) });
  if (result.outcome === "document-unsaved") {
    showToast(trans("Save the document first: the diagram is a file next to it."), "error", 12000);
  }
}

/**
 * Take one event of the main process into `view`. An event of a session that
 * `view` does not hold belongs to another editor and changes nothing here.
 */
function receiveTikzEditEvent(view: EditorView, event: TikzEditEvent): void {
  if (!view.state.field(tikzEditSessionsField).some((session) => session.id === event.id)) {
    return;
  }
  if (event.type === "ended") {
    view.dispatch({ effects: endTikzEditSession.of(event.id) });
    if (event.code !== null && event.code !== 0) {
      reportError(`Visual TikZ Editor stopped with exit code ${event.code}`);
      showToast(trans("Visual TikZ Editor stopped with an error."), "error", 12000);
    }
    return;
  }

  const update = externalTikzSourceUpdate(view.state, event.id, event.source);
  if (update.outcome === "applied") {
    view.dispatch(update.transaction);
  } else if (update.outcome === "stale") {
    showToast(
      trans(
        "The diagram changed in the document after Visual TikZ Editor opened it. The save of the editor was not taken. Undo the change in the document, or close the editor and open the diagram again.",
      ),
      "error",
      20000,
    );
  }
}

/**
 * The sessions of one editor view, with their link to the main process. The
 * view takes the saves of its sessions for as long as it holds this state. An
 * external editor has nowhere to save once the state is gone (a closed tab, a
 * document loaded again), so the plugin stops the editors of the state that
 * it leaves.
 */
export const tikzEditSessions = [
  tikzEditSessionsField,
  ViewPlugin.fromClass(
    class {
      private sessions: readonly TikzEditSession[];
      private readonly stopListening: () => void;

      constructor(view: EditorView) {
        this.sessions = view.state.field(tikzEditSessionsField);
        this.stopListening = window.ipc.on("tikz-edit", (_event, event: TikzEditEvent) => {
          receiveTikzEditEvent(view, event);
        });
      }

      update(update: ViewUpdate): void {
        this.sessions = update.state.field(tikzEditSessionsField);
      }

      destroy(): void {
        this.stopListening();
        for (const session of this.sessions) {
          window.ipc
            .invoke("application", { command: "tikz-edit-close", payload: session.id })
            .catch((error: unknown) => {
              reportError("Could not stop Visual TikZ Editor", error);
            });
        }
      }
    },
  ),
];
