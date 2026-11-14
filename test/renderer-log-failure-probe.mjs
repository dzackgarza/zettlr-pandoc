// Drives the scene of renderer-log-failure-entry.ts in the Electron of the
// app. It records the console messages of the window through the
// `console-message` event of its webContents, the event that `attachLogger`
// writes to the application log, and prints one JSON result line.

import { openScene } from "./visual/scene.mjs";

/** The time in which a second log request of a loop would arrive. */
const SETTLE_MS = 1_000;

const view = await openScene({ width: 400, height: 300 });
await view.browserWindow.evaluate((window) => {
  globalThis.consoleErrors = [];
  window.webContents.on("console-message", ({ level, message }) => {
    if (level === "error") {
      globalThis.consoleErrors.push(message);
    }
  });
});
await view.open(
  "renderer-log-failure.html",
  `<!doctype html><html><head><meta charset="utf-8"></head><body><script src="./renderer-log-failure-bundle.js"></script></body></html>`,
);
await view.page.waitForFunction(() => typeof window.logRequests === "function");
await view.page.waitForTimeout(SETTLE_MS);

process.stdout.write(
  `${JSON.stringify({
    logRequests: await view.page.evaluate(() => window.logRequests()),
    consoleErrors: await view.browserWindow.evaluate(() => globalThis.consoleErrors),
  })}\n`,
);
await view.close();
