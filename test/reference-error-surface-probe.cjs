"use strict";

// Drives the recoverable reference-error scene in Chromium, modeled on
// reference-create-label-probe.cjs. Loads the webpack bundle produced by
// reference-error-surface-build.cjs, forces a rejecting reference-provider
// invocation through the production error boundary, records the toast
// surface before and after a dismissal click, then types REAL keyboard
// input into the CodeMirror editor to prove it stayed interactive.
// Screenshots every state and prints one JSON result line the spec asserts
// on. While the boundary only logs (the Phase 8 red), the toast list stays
// empty and the spec fails on assertions, not on a crash.

const { app, BrowserWindow } = require("electron");
const fs = require("fs/promises");
const path = require("path");

const outputDirectory = process.argv[process.argv.length - 1];
// Typed into the editor AFTER the dismissal attempt: interactivity proof.
const TYPED_PROOF = "still-alive";

async function nextFrame(window) {
  await window.webContents.executeJavaScript(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
}

function sendKey(window, keyCode) {
  window.webContents.sendInputEvent({ type: "keyDown", keyCode });
  window.webContents.sendInputEvent({ type: "char", keyCode });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode });
}

async function screenshot(window, name) {
  const image = await window.webContents.capturePage();
  await fs.writeFile(path.join(outputDirectory, name), image.toPNG());
  return name;
}

app.setPath("userData", path.join(outputDirectory, "user-data"));

app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      width: 1100,
      height: 760,
      show: true,
      webPreferences: { offscreen: true },
    });
    const page = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; width: 100%; min-height: 100%; background: #e9eaec; color: #222; }
    #error-surface-editor { margin: 24px; background: #ffffff; border: 1px solid #c8ccd0; min-height: 200px; }
    .cm-editor { min-height: 200px; }
  </style></head><body><script src="./reference-error-surface-bundle.js"></script></body></html>`;
    const pagePath = path.join(outputDirectory, "reference-error-surface.html");
    await fs.writeFile(pagePath, page);
    await window.loadFile(pagePath);

    const readiness = await window.webContents.executeJavaScript(
      "typeof window.errorSurfaceProbeRun",
    );
    if (readiness !== "function") {
      throw new Error(
        `reference-error-surface-entry did not initialize (errorSurfaceProbeRun is ${readiness})`,
      );
    }

    const runReport = await window.webContents.executeJavaScript("window.errorSurfaceProbeRun()");
    await nextFrame(window);

    const toastsAfterFailure = await window.webContents.executeJavaScript(
      "window.errorSurfaceProbeToastState()",
    );
    const screenshots = [];
    screenshots.push(await screenshot(window, "error-surface-after-failure.png"));

    const dismissPerformed = await window.webContents.executeJavaScript(
      "window.errorSurfaceProbeDismiss()",
    );
    await nextFrame(window);
    const toastsAfterDismiss = await window.webContents.executeJavaScript(
      "window.errorSurfaceProbeToastState()",
    );
    screenshots.push(await screenshot(window, "error-surface-after-dismiss.png"));

    // Interactivity proof: focus the real editor and type with real
    // Chromium keyboard input.
    window.focus();
    window.webContents.focus();
    await window.webContents.executeJavaScript("window.errorSurfaceProbeFocusEditor()");
    await nextFrame(window);
    for (const character of TYPED_PROOF) {
      sendKey(window, character);
    }
    await nextFrame(window);
    const editorText = await window.webContents.executeJavaScript(
      "window.errorSurfaceProbeEditorText()",
    );
    screenshots.push(await screenshot(window, "error-surface-typing-after-dismiss.png"));

    const uncaught = await window.webContents.executeJavaScript(
      "window.errorSurfaceProbeUncaught()",
    );

    const result = {
      moduleAvailable: runReport.moduleAvailable === true,
      moduleFailure: runReport.moduleFailure ?? null,
      outcome: runReport.outcome ?? null,
      toastsAfterFailure,
      dismissPerformed,
      toastsAfterDismiss,
      typedProof: TYPED_PROOF,
      editorText,
      uncaught,
      screenshots,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    window.destroy();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
