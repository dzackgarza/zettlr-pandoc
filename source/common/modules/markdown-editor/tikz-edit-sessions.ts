/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikZ external edit sessions
 * CVM-Role:        Model
 * License:         GNU GPL v3
 *
 * Description:     A diagram that Visual TikZ Editor has open is a range of
 *                  the document. This field follows each such range through
 *                  the edits of the author and keeps the source that the
 *                  document and the external editor last agreed on. A save of
 *                  the external editor replaces the range only while the range
 *                  still holds that source.
 *
 * END HEADER
 */

import { type EditorState, StateEffect, StateField, type TransactionSpec } from "@codemirror/state";

export interface TikzEditSession {
  id: string;
  from: number;
  to: number;
  /** The source that the document and the external editor last agreed on. */
  source: string;
}

/** The external editor opened the range `from..to` as session `id`. */
export const beginTikzEditSession = StateEffect.define<{ id: string; from: number; to: number }>();

/** The external editor of session `id` stopped. */
export const endTikzEditSession = StateEffect.define<string>();

/** The transaction wrote `source` into the document at `from` for session `id`. */
const exchangeTikzSource = StateEffect.define<{ id: string; from: number; source: string }>();

export const tikzEditSessionsField = StateField.define<readonly TikzEditSession[]>({
  create: () => [],
  update(sessions, transaction) {
    let next = sessions;
    if (transaction.docChanged && sessions.length > 0) {
      // An insertion at either end of the diagram is text outside of it.
      next = sessions.map((session) => {
        const from = transaction.changes.mapPos(session.from, 1);
        return {
          ...session,
          from,
          to: Math.max(from, transaction.changes.mapPos(session.to, -1)),
        };
      });
    }
    for (const effect of transaction.effects) {
      if (effect.is(beginTikzEditSession)) {
        const { id, from, to } = effect.value;
        next = [
          ...next.filter((session) => session.id !== id),
          { id, from, to, source: transaction.state.sliceDoc(from, to) },
        ];
      } else if (effect.is(endTikzEditSession)) {
        next = next.filter((session) => session.id !== effect.value);
      } else if (effect.is(exchangeTikzSource)) {
        const { id, from, source } = effect.value;
        next = next.map((session) =>
          session.id === id ? { id, from, to: from + source.length, source } : session,
        );
      }
    }
    return next;
  },
});

export type ExternalTikzSourceUpdate =
  /** Dispatch `transaction` to take the source into the document. */
  | { outcome: "applied"; transaction: TransactionSpec }
  /** The author changed the diagram in the document after the last exchange. */
  | { outcome: "stale" }
  /** The document already holds this source. */
  | { outcome: "unchanged" }
  /** This state has no session `id`. */
  | { outcome: "closed" };

/**
 * What a save of the external editor does to the document. A stale save is
 * refused: the document is the authority, and a replaced range would discard
 * the change that the author made in it.
 */
export function externalTikzSourceUpdate(
  state: EditorState,
  id: string,
  source: string,
): ExternalTikzSourceUpdate {
  const session = state.field(tikzEditSessionsField).find((candidate) => candidate.id === id);
  if (session === undefined) {
    return { outcome: "closed" };
  }
  const current = state.sliceDoc(session.from, session.to);
  const exchange = exchangeTikzSource.of({ id, from: session.from, source });
  if (current === source) {
    return session.source === source
      ? { outcome: "unchanged" }
      : { outcome: "applied", transaction: { effects: exchange } };
  }
  if (current !== session.source) {
    return { outcome: "stale" };
  }
  return {
    outcome: "applied",
    transaction: {
      changes: { from: session.from, to: session.to, insert: source },
      effects: exchange,
    },
  };
}
