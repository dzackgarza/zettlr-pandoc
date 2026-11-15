/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The close of a main window with its documents
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The window provider closes a main window through
 *                  closeWithDocuments. The spec runs that function with a
 *                  documents provider of each answer: it lets the window
 *                  go, it keeps the window, and it fails. A failed close
 *                  keeps the window and shows its cause in the window (#57).
 *                  The answers that the real provider gives are proven in
 *                  the assembled app (`e2e/window-close.spec.ts`).
 *
 * END HEADER
 */

import "./headless-electron-harness.cjs";
import { strict as assert } from "node:assert";
import {
  type ClosingWindow,
  closeWithDocuments,
  type WindowCloseDocuments,
} from "source/app/service-providers/windows/close-with-documents";
import { COMMAND_FAILED_CHANNEL } from "source/types/common/command-failure";

const WINDOW_ID = "window-2";

/** A window that records its closes and the messages that it gets. */
function recordingWindow(): { window: ClosingWindow; closes: number[]; sent: unknown[][] } {
  const closes: number[] = [];
  const sent: unknown[][] = [];
  const window: ClosingWindow = {
    close: () => {
      closes.push(closes.length + 1);
    },
    webContents: {
      isDestroyed: () => false,
      isCrashed: () => false,
      send: (channel: string, ...args: unknown[]) => {
        sent.push([channel, ...args]);
      },
    },
  };
  return { window, closes, sent };
}

/** A log that keeps each error. */
function recordingLog(): {
  logger: { error: (message: string, details?: unknown) => void };
  errors: string[];
} {
  const errors: string[] = [];
  return {
    logger: {
      error: (message: string) => {
        errors.push(message);
      },
    },
    errors,
  };
}

/** A documents provider whose window is clean or not, with one answer for the close. */
function documentsThat(
  clean: boolean,
  answer: () => Promise<boolean>,
): { documents: WindowCloseDocuments; calls: string[] } {
  const calls: string[] = [];
  return {
    documents: {
      isClean: (windowId) => {
        calls.push(`isClean ${windowId}`);
        return clean;
      },
      askUserToCloseWindow: async (windowId) => {
        calls.push(`askUserToCloseWindow ${windowId}`);
        return await answer();
      },
      closeWindow: async (windowId) => {
        calls.push(`closeWindow ${windowId}`);
        return await answer();
      },
    },
    calls,
  };
}

describe("The close of a main window with its documents", function () {
  it("closes a clean window that the documents provider lets go", async function () {
    const { window, closes, sent } = recordingWindow();
    const { logger, errors } = recordingLog();
    const { documents, calls } = documentsThat(true, async () => true);
    const order: string[] = [];

    await closeWithDocuments(window, WINDOW_ID, documents, logger, () => {
      order.push(`permitted before close ${closes.length + 1}`);
    });

    assert.deepEqual(calls, [`isClean ${WINDOW_ID}`, `closeWindow ${WINDOW_ID}`]);
    assert.deepEqual(
      order,
      ["permitted before close 1"],
      "the close is permitted before it starts",
    );
    assert.deepEqual(closes, [1]);
    assert.deepEqual(sent, []);
    assert.deepEqual(errors, []);
  });

  it("asks the author about a window with unsaved text, and closes it on the answer", async function () {
    const { window, closes } = recordingWindow();
    const { logger } = recordingLog();
    const { documents, calls } = documentsThat(false, async () => true);
    let permitted = 0;

    await closeWithDocuments(window, WINDOW_ID, documents, logger, () => {
      permitted += 1;
    });

    assert.deepEqual(calls, [`isClean ${WINDOW_ID}`, `askUserToCloseWindow ${WINDOW_ID}`]);
    assert.equal(permitted, 1);
    assert.deepEqual(closes, [1]);
  });

  it("keeps a window that the documents provider keeps, and shows nothing itself", async function () {
    for (const clean of [true, false]) {
      const { window, closes, sent } = recordingWindow();
      const { logger, errors } = recordingLog();
      const { documents } = documentsThat(clean, async () => false);
      let permitted = 0;

      await closeWithDocuments(window, WINDOW_ID, documents, logger, () => {
        permitted += 1;
      });

      assert.equal(permitted, 0, "no close is permitted");
      assert.deepEqual(closes, [], "the window stays");
      assert.deepEqual(sent, [], "the provider told the author; the window gets no second message");
      assert.deepEqual(errors, []);
    }
  });

  it("keeps a window whose close fails, and shows the cause in the window (#57)", async function () {
    for (const clean of [true, false]) {
      const { window, closes, sent } = recordingWindow();
      const { logger, errors } = recordingLog();
      const { documents } = documentsThat(clean, async () => {
        throw new Error("Document /notes/genus.md is not loaded");
      });
      let permitted = 0;

      await closeWithDocuments(window, WINDOW_ID, documents, logger, () => {
        permitted += 1;
      });

      assert.equal(permitted, 0, "no close is permitted");
      assert.deepEqual(closes, [], "the window is not closed without its documents");
      assert.deepEqual(sent, [
        [
          COMMAND_FAILED_CHANNEL,
          {
            command: "close-window",
            message: "The window was not closed: Document /notes/genus.md is not loaded",
          },
        ],
      ]);
      assert.deepEqual(errors, ["[WindowManager] Could not close the window"]);
    }
  });

  it("gives the documents provider a repeat that closes the window", async function () {
    const { window, closes } = recordingWindow();
    const { logger } = recordingLog();
    let repeat: (() => Promise<void>) | undefined;
    const documents: WindowCloseDocuments = {
      isClean: () => true,
      askUserToCloseWindow: async () => false,
      closeWindow: async (_windowId, closeAgain) => {
        repeat = closeAgain;
        return false;
      },
    };

    await closeWithDocuments(window, WINDOW_ID, documents, logger, () => {});
    assert.deepEqual(closes, [], "the refused close keeps the window");

    assert.ok(repeat !== undefined, "the provider got the repeat");
    await repeat();
    assert.deepEqual(closes, [1], "the repeat is a close of the window");
  });
});
