/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Save-refusal and reload-failure toast specs
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A save that the window asked for and that did not land,
 *                  and a reload of a changed file that failed, each show a
 *                  message in the window. This spec drives the real
 *                  `saveBuffer` and the real load-failure surface against a
 *                  preload bridge that answers as the documents provider
 *                  does. The message names the cause that the provider gave,
 *                  a refusal that the disk version resolves offers that as
 *                  an action, and a refusal that leaves text which cannot
 *                  reach its file offers a copy of that text (#178).
 *
 * END HEADER
 */

// The bridge must be on the window before a renderer module reads it.
import "./document-collaboration-ipc-double";
import { collab } from "@codemirror/collab";
import { EditorState } from "@codemirror/state";
import { strict as assert } from "assert";
import { saveBuffer } from "source/common/modules/markdown-editor/util/save-buffer";
import {
  dismissAllNotifications,
  type NotificationEntry,
  notificationEntries,
  runNotificationAction,
} from "source/common/util/show-toast";
import type { SaveFileResult } from "source/types/common/documents";
import { surfaceDocumentLoadFailure } from "source/win-main/util/surface-document-load-error";
import { documentCollaborationIpcDouble } from "./document-collaboration-ipc-double";

const FILE = "/notes/lattices.md";

interface Request {
  command: string;
  payload?: unknown;
}

describe("A save or a reload that the window asked for and that did not happen", function () {
  let requests: Request[];
  const state = EditorState.create({
    doc: "An even unimodular lattice has a rank that 8 divides.",
    extensions: [collab({ startVersion: 0 })],
  });

  beforeEach(function () {
    dismissAllNotifications();
    documentCollaborationIpcDouble.reset();
    requests = [];
  });

  /** The documents provider answers each save with `answer`. */
  function providerAnswers(answer: () => Promise<SaveFileResult>): void {
    documentCollaborationIpcDouble.setInvokeResponder(async (request) => {
      requests.push(request);
      if (request.command === "documents:save-file") {
        return await answer();
      }
      return undefined;
    });
  }

  function errors(): NotificationEntry[] {
    return notificationEntries().filter((entry) => entry.kind === "error");
  }

  it("names the cause when the save request fails", async function () {
    const cause = "EROFS: read-only file system, open '/userdata/review-sidecars/9f2c.json.tmp'";
    providerAnswers(async () => {
      throw new Error(cause);
    });

    assert.equal(await saveBuffer(() => state, FILE), false);

    assert.equal(errors().length, 1, "one error is shown");
    assert.ok(
      errors()[0].message.includes(cause),
      `the error names the cause: ${errors()[0].message}`,
    );
  });

  it("offers the disk version when the file changed on disk under a review", async function () {
    const message = "The document changed on disk after this review opened.";
    providerAnswers(async () => ({ ok: false, refusal: { reason: "disk-changed", message } }));

    assert.equal(await saveBuffer(() => state, FILE), false);

    assert.deepEqual(
      errors().map((entry) => entry.message),
      [message],
      "the refusal of the provider is shown",
    );
    assert.equal(errors()[0].action !== undefined, true, "the refusal has an action");
    runNotificationAction(errors()[0].id);
    assert.deepEqual(
      requests.filter((request) => request.command === "load-from-disk"),
      [{ command: "load-from-disk", payload: { path: FILE } }],
      "the action loads the disk version of that document",
    );
  });

  it("offers a copy of the text when the file cannot be written", async function () {
    providerAnswers(async () => ({
      ok: false,
      refusal: { reason: "write-failed", message: "Could not save file lattices.md: EROFS" },
    }));

    assert.equal(await saveBuffer(() => state, FILE), false);

    assert.deepEqual(
      errors().map((entry) => entry.message),
      ["Could not save file lattices.md: EROFS"],
      "the refusal of the provider is shown",
    );
    assert.equal(errors()[0].action !== undefined, true, "the refusal has an action");
    runNotificationAction(errors()[0].id);
    assert.deepEqual(
      requests.filter((request) => ["save-copy", "load-from-disk"].includes(request.command)),
      [{ command: "save-copy", payload: { path: FILE } }],
      "the action asks for a copy of the text of that document, and for no disk version",
    );
  });

  it("offers no action for a refusal that leaves no text to rescue", async function () {
    providerAnswers(async () => ({
      ok: false,
      refusal: { reason: "not-loaded", message: "The application holds no text of lattices.md." },
    }));

    assert.equal(await saveBuffer(() => state, FILE), false);

    assert.deepEqual(
      errors().map((entry) => [entry.message, entry.action]),
      [["The application holds no text of lattices.md.", undefined]],
    );
  });

  it("offers the disk version again when a reload of a changed file failed", function () {
    providerAnswers(async () => ({ ok: true }));

    surfaceDocumentLoadFailure(FILE, {
      message: "EBUSY: resource busy or locked",
      diagnostic: "Error: EBUSY: resource busy or locked",
    });

    assert.equal(errors().length, 1, "one error is shown");
    assert.equal(errors()[0].action !== undefined, true, "the failed reload has an action");
    runNotificationAction(errors()[0].id);
    assert.deepEqual(
      requests.filter((request) => request.command === "load-from-disk"),
      [{ command: "load-from-disk", payload: { path: FILE } }],
      "the action asks for the disk version of that document again",
    );
  });
});
