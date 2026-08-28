"use strict";

// Drives the rename-preview dialog with real Chromium input, modeled on
// reference-create-label-probe.cjs. Loads the webpack bundle produced by
// reference-rename-preview-build.cjs, mounts the dialog over the previewed
// fixture rename, screenshots the rendered preview (the contract's
// "rename preview" capture), exercises Cancel in one scene and Apply in a
// fresh scene, and prints one JSON result line the spec asserts on. While
// the dialog does not exist (the review A4 red), the entry reports that as
// structured data and this probe still exits 0 with a complete result
// object — the spec fails on assertions, not on a crash.

const { app, BrowserWindow } = require("electron");
const fs = require("fs/promises");
const { readFileSync } = require("fs");
const path = require("path");

const outputDirectory = process.argv[process.argv.length - 1];
const OLD_KEY = "thm:torelli";
const NEW_KEY = "thm:torelli-headline";

const fixtureRoot = path.join(__dirname, "fixtures", "reference-workspace");
const documents = [
  path.join(fixtureRoot, "ProjectA", "Theorems.md"),
  path.join(fixtureRoot, "ProjectA", "Halphen_Surfaces.md"),
  path.join(fixtureRoot, "ProjectB", "Other_Paper.md"),
  path.join(fixtureRoot, "Standalone_Notes.md"),
].map((documentPath) => ({
  path: documentPath,
  content: readFileSync(documentPath, "utf-8"),
}));

async function nextFrame(window) {
  await window.webContents.executeJavaScript(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
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
    html, body, #app { margin: 0; width: 100%; min-height: 100%; background: #e9eaec; color: #222; }
  </style></head><body><main id="app"></main><script src="./reference-rename-preview-bundle.js"></script></body></html>`;
    const pagePath = path.join(outputDirectory, "reference-rename-preview.html");
    await fs.writeFile(pagePath, page);
    await window.loadFile(pagePath);

    const readiness = await window.webContents.executeJavaScript(
      "typeof window.renamePreviewProbeMount",
    );
    if (readiness !== "function") {
      throw new Error(
        `reference-rename-preview-entry did not initialize (renamePreviewProbeMount is ${readiness})`,
      );
    }

    const mountArgs = `${JSON.stringify(documents)}, ${JSON.stringify(OLD_KEY)}, ${JSON.stringify(NEW_KEY)}`;

    // ——— Scene 1: preview + Cancel (commits nothing).
    const mountReport = await window.webContents.executeJavaScript(
      `window.renamePreviewProbeMount(${mountArgs})`,
    );

    let previewState = null;
    let cancelScene = null;
    const screenshots = [];
    if (mountReport.componentAvailable === true) {
      window.focus();
      window.webContents.focus();
      await nextFrame(window);
      previewState = await window.webContents.executeJavaScript("window.renamePreviewProbeState()");
      screenshots.push(await screenshot(window, "rename-preview-dialog.png"));

      const cancelClicked = await window.webContents.executeJavaScript(
        "window.renamePreviewProbeClick('.rename-preview-dialog [data-cancel]')",
      );
      await nextFrame(window);
      cancelScene = {
        cancelClicked,
        events: await window.webContents.executeJavaScript("window.renamePreviewProbeEvents()"),
      };
      screenshots.push(await screenshot(window, "rename-preview-after-cancel.png"));
    }

    // ——— Scene 2 (fresh JS context): preview + Apply (proceeds exactly once).
    await window.loadFile(pagePath);
    const applyMountReport = await window.webContents.executeJavaScript(
      `window.renamePreviewProbeMount(${mountArgs})`,
    );

    let applyScene = null;
    if (applyMountReport.componentAvailable === true) {
      await nextFrame(window);
      const applyClicked = await window.webContents.executeJavaScript(
        "window.renamePreviewProbeClick('.rename-preview-dialog [data-apply]')",
      );
      await nextFrame(window);
      applyScene = {
        applyClicked,
        events: await window.webContents.executeJavaScript("window.renamePreviewProbeEvents()"),
      };
      screenshots.push(await screenshot(window, "rename-preview-after-apply.png"));
    }

    const result = {
      componentAvailable: mountReport.componentAvailable === true,
      componentFailure: mountReport.componentFailure ?? null,
      oldKey: OLD_KEY,
      newKey: NEW_KEY,
      expectedFiles: mountReport.expectedFiles ?? [],
      previewState,
      cancelScene,
      applyScene,
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
