/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Remote Document
 * CVM-Role:        Utility
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This module defines a set of functions required by the
 *                  editor to retrieve, update, and sync with the document
 *                  provider.
 *
 * END HEADER
 */

import {
  collab,
  getSyncedVersion,
  receiveUpdates,
  sendableUpdates,
  type Update,
} from "@codemirror/collab";
import { ChangeSet, type Extension, StateEffect } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
// This plugin implements remote callbacks that keep the editor's document in
// sync with a central authority
import { trans } from "@common/i18n-renderer";
import { reportError } from "@common/util/error-reporting";
import { pathBasename } from "@common/util/renderer-path-polyfill";
import serializeChangeSet from "@common/util/serialize-change-set";
import showToast from "@common/util/show-toast";
import type { SerializedUpdate } from "@dts/common/documents";
import { configField } from "../util/configuration";

export type PullUpdateCallback = (
  filePath: string,
  version: number,
) => Promise<SerializedUpdate[] | false>;
export type PushUpdateCallback = (
  filePath: string,
  version: number,
  updates: SerializedUpdate[],
) => Promise<boolean>;

/**
 * NOTE: The caller MUST listen for this state effect. If this effect is being
 * emitted, the document is irrepairably out of sync with the document authority
 * and the entire state must be reinitialized.
 */
export const reloadStateEffect = StateEffect.define<boolean>();

/** The time between an answered push and the push of the updates made since. */
const NEXT_PUSH_DELAY = 100;
/** The time between a rejected push and the next push of the same updates. */
const REJECTED_PUSH_DELAY = 1000;

/**
 * Call this function to retrieve an Extension that can be used to synchronize
 * an editor with a central document authority.
 * @param   {string}              filePath      The file's path to be requested
 * @param   {number}              startVersion  Retrieve this when you retrieve
 *                                              the document initially.
 * @param   {PullUpdateCallback}  pullUpdates   The callback to request new
 *                                              updates from the document
 *                                              authority.
 * @param   {PushUpdateCallback}  pushUpdates   The callback to send updates to
 *                                              the document authority.
 *
 * @return  {Extension}                         A CodeMirror v6 extension
 */
export function hookDocumentAuthority(
  filePath: string,
  startVersion: number,
  pullUpdates: PullUpdateCallback,
  pushUpdates: PushUpdateCallback,
): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      private isCurrentlyPushing: boolean;
      private pluginDestroyed: boolean;
      /** The one scheduled push. An update pushes at once and leaves it. */
      private scheduledPush: ReturnType<typeof setTimeout> | undefined;
      /**
       * Whether the author saw a rejection since the last accepted push. The
       * message of a rejection names the temporary file of that write, so two
       * rejections of one cause have different messages.
       */
      private rejectionShown: boolean;

      constructor(private readonly view: EditorView) {
        this.isCurrentlyPushing = false;
        this.pluginDestroyed = false;
        this.rejectionShown = false;

        // Immediately enter a loop to pull updates to the document. The pull
        // method will create a Promise that links this plugin (and, by extension,
        // the editor state) over the IPC or websocket bridge until there are any
        // updates available.
        this.pull().catch((err) => {
          reportError(`Pulling updates failed: ${String(err.message)}`, err);
        });
      }

      update(update: ViewUpdate): void {
        // Whenever the doc changed, sync those changes with the document authority
        if (update.docChanged) {
          this.push().catch((err) => {
            reportError(`Pushing updates failed: ${String(err.message)}`, err);
          });
        }
      }

      // The loop is the push loop of the CodeMirror collaboration example
      // (https://codemirror.net/examples/collab/): one push at a time, and
      // another push after each answer while updates are unsent. The authority
      // of this application can reject a push (the review of the document could
      // not be written). The updates stay unsent then, and the loop sends them
      // again until the authority takes them.
      async push(): Promise<void> {
        if (this.isCurrentlyPushing || this.pluginDestroyed) {
          return; // Another push is going on, or the editor is gone
        }

        const updates = sendableUpdates(this.view.state);
        if (updates.length === 0) {
          return; // No updates available
        }

        this.isCurrentlyPushing = true;
        const version = getSyncedVersion(this.view.state);
        const serializedUpdates: SerializedUpdate[] = updates.map((u) => {
          return { clientID: u.clientID, changes: serializeChangeSet(u.changes) };
        });

        const delay = await pushUpdates(filePath, version, serializedUpdates).then(
          () => {
            this.rejectionShown = false;
            return NEXT_PUSH_DELAY;
          },
          (err: Error) => {
            this.showRejection(err);
            return REJECTED_PUSH_DELAY;
          },
        );

        // Allow another push, if new updates have amassed during the push
        this.isCurrentlyPushing = false;
        this.schedulePush(delay);
      }

      /** Tells the author one time why the document does not take the text. */
      private showRejection(err: Error): void {
        if (this.pluginDestroyed || this.rejectionShown) {
          return;
        }
        this.rejectionShown = true;
        reportError(`Pushing updates failed: ${err.message}`, err);
        showToast(
          trans(
            "The document did not take the changes to %s. The editor sends them again until it does. Cause: %s",
            pathBasename(filePath),
            err.message,
          ),
          "error",
        );
      }

      private schedulePush(delay: number): void {
        if (this.pluginDestroyed || this.scheduledPush !== undefined) {
          return;
        }
        this.scheduledPush = setTimeout(() => {
          this.scheduledPush = undefined;
          this.push().catch((err) => {
            reportError(`Pushing updates failed: ${String(err.message)}`, err);
          });
        }, delay);
      }

      async pull(): Promise<void> {
        if (this.pluginDestroyed) {
          return; // Do not attempt a new pull
        }

        const version = getSyncedVersion(this.view.state);
        const updates = await pullUpdates(filePath, version);
        // NOTE: At this point, hours may have passed, so we have to re-check the
        // current state, because the view will remain valid for as long as the
        // editor leaf exists. *However* if the editor now shows a different file,
        // the state will have a different remote-doc plugin that already takes
        // care of communicating with the API, so we have to remove this "dangling
        // promise".
        const currentFilePath = this.view.state.field(configField).metadata.path;
        if (this.pluginDestroyed || filePath !== currentFilePath) {
          return; // These updates shall not be applied to the current state
        }

        if (updates === false) {
          // By returning `false`, the authority told us that we've lost
          // synchronization and there is no way to re-synchronize in this method.
          // This means that here we need to emit an effect that must be captured
          // by the MainEditor instance to perform a full reload of the document
          // state. After that, we break out of the pull loop and let the new
          // plugin instance take over.
          this.view.dispatch({ effects: reloadStateEffect.of(true) });
          return;
        }

        try {
          // Deserialize & apply updates
          const deserializedUpdates = updates.map((u) => {
            return {
              clientID: u.clientID,
              changes: ChangeSet.fromJSON(u.changes),
            };
          });
          const transaction = receiveUpdates(this.view.state, deserializedUpdates);
          this.view.dispatch(transaction);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          reportError(`Pulling updates for failed (retrying): ${message}`, err);
        }

        // Whether there was an error or not, schedule another pull
        this.pull().catch((err) => {
          reportError(`Pulling updates failed: ${String(err.message)}`, err);
        });
      }

      destroy(): void {
        // This ensures that the client stops trying to receive updates after the
        // editor has been removed (hence, no dangling promises that will prevent
        // a smooth shutdown of the application)
        this.pluginDestroyed = true;
        clearTimeout(this.scheduledPush);
      }
    },
  );

  return [collab({ startVersion }), plugin];
}
