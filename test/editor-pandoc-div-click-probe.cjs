"use strict";

const { app, BrowserWindow } = require("electron");
const fs = require("fs/promises");
const path = require("path");

const outputDirectory = process.argv[process.argv.length - 1];
const contentLines = [
  "First target alpha.",
  "Second target omega.",
  "Third target gamma.",
  "Fourth target delta.",
];
const targets = [
  { kind: "text", text: "alpha" },
  { kind: "text", text: "omega" },
  { kind: "text", text: "gamma" },
  { kind: "text", text: "delta" },
  { kind: "text", text: "Before outside." },
  { kind: "text", text: "Between outside." },
  { kind: "text", text: "After outside target." },
  { kind: "label", text: "Definition" },
  { kind: "label", text: "Warning" },
  ...contentLines.flatMap((text) => [
    { kind: "gutter", side: "left", text },
    { kind: "gutter", side: "right", text },
  ]),
];

async function nextFrame(window) {
  await window.webContents.executeJavaScript(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
}

async function probeTarget(window, targetSpec) {
  await window.webContents.executeJavaScript("window.clickProbeReset()");
  await nextFrame(window);
  const targetExpression =
    targetSpec.kind === "gutter"
      ? `window.clickProbePanelGutterTarget(${JSON.stringify(targetSpec.text)}, ${JSON.stringify(targetSpec.side)})`
      : targetSpec.kind === "label"
        ? `window.clickProbeLabelTarget(${JSON.stringify(targetSpec.text)})`
        : `window.clickProbeTarget(${JSON.stringify(targetSpec.text)})`;
  const target = await window.webContents.executeJavaScript(targetExpression);

  window.webContents.sendInputEvent({
    type: "mouseMove",
    x: Math.round(target.x),
    y: Math.round(target.y),
  });
  window.webContents.sendInputEvent({
    type: "mouseDown",
    x: Math.round(target.x),
    y: Math.round(target.y),
    button: "left",
    clickCount: 1,
  });
  window.webContents.sendInputEvent({
    type: "mouseUp",
    x: Math.round(target.x),
    y: Math.round(target.y),
    button: "left",
    clickCount: 1,
  });
  await nextFrame(window);

  return {
    kind: targetSpec.kind,
    side: targetSpec.side,
    text: targetSpec.text,
    expectedFrom: target.expectedFrom,
    expectedTo: target.expectedTo,
    expectedAtCoords: target.expectedAtCoords,
    hitTag: target.hitTag,
    actual: await window.webContents.executeJavaScript("window.clickProbeAnchor()"),
  };
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
    html, body { margin: 0; min-height: 100%; background: #fff; color: #222; }
    body { padding: 24px; box-sizing: border-box; }
    #editor { max-width: 860px; margin: 0 auto; }
    .cm-editor { min-height: 620px; }
    .cm-scroller { padding: 18px 22px 60px; overflow-x: hidden; }
  </style></head><body><main id="editor"></main><script src="./pandoc-div-click-bundle.js"></script></body></html>`;
    const pagePath = path.join(outputDirectory, "pandoc-div-click.html");
    await fs.writeFile(pagePath, page);
    await window.loadFile(pagePath);
    await window.webContents.executeJavaScript("window.clickProbeReady");
    window.focus();
    window.webContents.focus();

    const results = [];
    for (const targetSpec of targets) {
      results.push(await probeTarget(window, targetSpec));
    }
    process.stdout.write(`${JSON.stringify(results)}\n`);
    window.destroy();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
