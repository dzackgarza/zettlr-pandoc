/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Toast action-affordance specs (issue #1, review A5 red)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks the action affordance onto the closable toast
 *                  utility: a toast may carry one labeled action button
 *                  (the surface that makes the committed workspace rename's
 *                  undo user-reachable, US-17). The action runs exactly
 *                  once, dismisses the toast, and never leaks onto
 *                  action-free toasts; dismissing the toast without the
 *                  button never runs the action. Also locks the
 *                  notification-center semantics: every toast times out
 *                  and folds into the notification log, hovering pauses
 *                  the timeout, a dismissal removes the message from the
 *                  screen and the log, and an open center takes new
 *                  messages instead of toasts.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import showToast, {
  dismissAllNotifications,
  dismissNotification,
  notificationEntries,
  runNotificationAction,
  setNotificationCenterOpen,
} from "source/common/util/show-toast";

const CONTAINER_ID = "zettlr-toast-container";

describe("Toast action affordance (review A5)", function () {
  afterEach(function () {
    setNotificationCenterOpen(false);
    dismissAllNotifications();
    document.getElementById(CONTAINER_ID)?.remove();
  });

  function toasts(): HTMLElement[] {
    return Array.from(document.querySelectorAll(`#${CONTAINER_ID} .zettlr-toast`));
  }

  it("renders one labeled action button and runs the action exactly once on click", function () {
    let actionRuns = 0;
    showToast("Renamed thm:torelli to thm:headline across 4 documents.", "info", 6000, {
      label: "Undo",
      onAction: () => {
        actionRuns++;
      },
    });

    const toast = toasts()[0];
    assert.notStrictEqual(toast, undefined, "the toast must render");

    const button = toast.querySelector<HTMLButtonElement>("button[data-toast-action]");
    assert.ok(button !== null, "the action toast must render its action as a real button");
    assert.strictEqual(button.textContent, "Undo", "the button must carry the supplied label");

    assert.strictEqual(actionRuns, 0, "rendering must not run the action");
    button.click();
    assert.strictEqual(actionRuns, 1, "clicking the button must run the action exactly once");
    assert.strictEqual(toasts().length, 0, "the acted-on toast must dismiss itself");
  });

  it("keeps toast text available when the body is clicked and closes only from its button", function () {
    let actionRuns = 0;
    showToast("Renamed with pending undo.", "info", 6000, {
      label: "Undo",
      onAction: () => {
        actionRuns++;
      },
    });

    const toast = toasts()[0];
    assert.notStrictEqual(toast, undefined, "the toast must render");
    toast.click();
    assert.strictEqual(toasts().length, 1, "clicking the body leaves the message available");
    assert.strictEqual(actionRuns, 0, "dismissal is not the action");
    assert.equal(getComputedStyle(toast).userSelect, "text");
    toast.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')?.click();
    assert.strictEqual(toasts().length, 0);
  });

  it("action-free toasts render no action button", function () {
    showToast("Loading workspace references failed.", "error");
    const toast = toasts()[0];
    assert.notStrictEqual(toast, undefined, "the toast must render");
    assert.strictEqual(
      toast.querySelector("button[data-toast-action]"),
      null,
      "a toast without an action must not grow a button",
    );
  });

  it("gives an error toast a copy control", function () {
    showToast("Flowmark failed: full diagnostic", "error");
    assert.equal(toasts()[0].querySelector("button[data-toast-copy]")?.textContent, "Copy");
  });

  it("folds a timed-out toast of either kind into the notification log", async function () {
    showToast("Flowmark failed: full diagnostic", "error", 10);
    showToast("Saved.", "info", 10);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(toasts().length, 0, "every toast leaves the screen at its timeout");
    assert.deepEqual(
      notificationEntries().map((entry) => [entry.kind, entry.message]),
      [
        ["error", "Flowmark failed: full diagnostic"],
        ["info", "Saved."],
      ],
    );
  });

  it("pauses the timeout while the pointer is on the toast", async function () {
    showToast("Read me slowly.", "info", 10);
    toasts()[0].dispatchEvent(new MouseEvent("mouseenter"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(toasts().length, 1, "a hovered toast stays");
    toasts()[0].dispatchEvent(new MouseEvent("mouseleave"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(toasts().length, 0, "the timeout restarts when the pointer leaves");
  });

  it("removes a dismissed message from the screen and the log", function () {
    showToast("First.");
    showToast("Second.");
    toasts()[0].querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')?.click();
    assert.deepEqual(
      notificationEntries().map((entry) => entry.message),
      ["Second."],
    );
    dismissNotification(notificationEntries()[0].id);
    assert.equal(toasts().length, 0);
    assert.equal(notificationEntries().length, 0);
  });

  it("dismisses every message at once", function () {
    showToast("First.");
    showToast("Second.", "error");
    dismissAllNotifications();
    assert.equal(toasts().length, 0);
    assert.equal(notificationEntries().length, 0);
  });

  it("keeps the action of a folded message runnable from the log", async function () {
    let actionRuns = 0;
    showToast("Renamed.", "info", 10, {
      label: "Undo",
      onAction: () => {
        actionRuns++;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    runNotificationAction(notificationEntries()[0].id);
    assert.equal(actionRuns, 1);
    assert.equal(notificationEntries().length, 0, "the acted-on message leaves the log");
  });

  it("moves toasts into the open center and shows new messages only there", function () {
    showToast("Before opening.");
    setNotificationCenterOpen(true);
    assert.equal(toasts().length, 0, "opening the center takes the visible toasts");
    showToast("While open.");
    assert.equal(toasts().length, 0, "an open center takes new messages");
    assert.deepEqual(
      notificationEntries().map((entry) => entry.message),
      ["Before opening.", "While open."],
    );
  });
});
