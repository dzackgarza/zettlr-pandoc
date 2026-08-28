"use strict";

// Captures the production combined `@` completion surface (issue #1,
// ledger C4): the open popup listing citation entries and typed label
// entries together, one frame with a label option's info panel (the
// quick-help link), and one frame with the disabled another-Project entry
// selected — whose inert apply the driver also proves against the real
// document. Follows the editor-reference-chips-visual-capture.cjs pattern.

const { app, BrowserWindow } = require("electron");
const fs = require("fs/promises");
const path = require("path");

const outputDirectory = process.argv[process.argv.length - 1];
// 1280 wide with a left-anchored editor: the popup needs more than 400px of
// free space beside it, or CodeMirror positions the selected option's info
// panel in "narrow" mode OVER the option list.
const scenes = [
  { name: "reference-completion-combined-light", dark: false, width: 1280, height: 800 },
  { name: "reference-completion-combined-dark", dark: true, width: 1280, height: 800 },
  {
    name: "reference-completion-label-info-light",
    dark: false,
    width: 1280,
    height: 800,
    select: "thm:torelli",
  },
  {
    name: "reference-completion-outside-project-light",
    dark: false,
    width: 1280,
    height: 800,
    select: "lem:kodaira:embedding",
    proveInert: true,
  },
];

// Citations precede label entries (the delegation contract); label entries
// follow in workspace document order.
const EXPECTED_LABELS = [
  "Ols04",
  "Kod63",
  "BHPV04",
  "thm:torelli",
  "eq:intersection-form",
  "tbl:coble-lattices",
  "lem:kodaira:embedding",
];

async function waitFor(window, expression, description) {
  for (let i = 0; i < 100; i++) {
    const outcome = await window.webContents.executeJavaScript(expression);
    if (outcome === true) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function capture(window, scene) {
  const background = scene.dark ? "#2b2b2c" : "#ffffff";
  const foreground = scene.dark ? "#e5e7eb" : "#222222";
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; min-height: 100%; background: ${background}; color: ${foreground}; }
    body { padding: 28px; box-sizing: border-box; }
    #editor { max-width: 700px; margin: 0; }
    .cm-editor { min-height: 620px; }
    .cm-scroller { padding: 18px 22px 60px; overflow-x: hidden; }
    .cm-content { overflow-wrap: anywhere; }
  </style></head><body data-dark="${scene.dark}">
    <main id="editor"></main><script src="./reference-completion-visual-bundle.js"></script>
  </body></html>`;
  const pagePath = path.join(outputDirectory, `${scene.name}.html`);
  await fs.writeFile(pagePath, page);
  window.setSize(scene.width, scene.height);
  await window.loadFile(pagePath);
  await window.webContents.executeJavaScript("window.captureReady");

  const labels = await window.webContents.executeJavaScript("window.completionProbeOptionLabels()");
  if (JSON.stringify(labels) !== JSON.stringify(EXPECTED_LABELS)) {
    throw new Error(`${scene.name} presented the wrong option list: ${JSON.stringify(labels)}`);
  }

  if (scene.select !== undefined) {
    const selection = await window.webContents.executeJavaScript(
      `window.completionProbeSelect(${JSON.stringify(scene.select)})`,
    );
    if (selection.selected !== true) {
      throw new Error(
        `${scene.name} could not select the ${scene.select} option; walked: ${JSON.stringify(selection.seen)}`,
      );
    }
    // The selected label option's info panel (the US-06 quick-help link)
    // renders asynchronously beside the popup.
    await waitFor(
      window,
      "document.querySelector('.cm-completionInfo [data-open-help]') !== null",
      `${scene.name}'s label info panel with its quick-help link`,
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 150));
  const diagnostics = await window.webContents.executeJavaScript(`(() => {
    const tooltip = document.querySelector('.cm-tooltip-autocomplete')
    const options = Array.from(document.querySelectorAll('.cm-tooltip-autocomplete li'))
    const details = Array.from(document.querySelectorAll('.cm-completionDetail')).map(detail => detail.textContent)
    const info = document.querySelector('.cm-completionInfo')
    const tooltipRect = tooltip === null ? null : tooltip.getBoundingClientRect()
    const infoRect = info === null ? null : info.getBoundingClientRect()
    return {
      infoBesideList: tooltipRect !== null && infoRect !== null &&
        (infoRect.left >= tooltipRect.right - 1 || infoRect.right <= tooltipRect.left + 1),
      hasTooltip: tooltip !== null,
      renderedOptions: options.length,
      selectedLabel: options.find(option => option.getAttribute('aria-selected') === 'true')?.querySelector('.cm-completionLabel')?.textContent ?? null,
      details,
      infoText: info === null ? null : info.textContent,
      infoHasHelpLink: document.querySelector('.cm-completionInfo [data-open-help]') !== null,
    }
  })()`);
  console.log(scene.name, JSON.stringify(diagnostics));

  if (!diagnostics.hasTooltip || diagnostics.renderedOptions !== EXPECTED_LABELS.length) {
    throw new Error(`${scene.name} did not render the full combined option list`);
  }
  if (
    !diagnostics.details.includes("Theorem — Torelli for Enriques") ||
    !diagnostics.details.includes("Equation") ||
    !diagnostics.details.includes("Lemma — Kodaira embedding for Halphen pencils")
  ) {
    throw new Error(
      `${scene.name} is missing the Type — title label details: ${JSON.stringify(diagnostics.details)}`,
    );
  }
  if (scene.select !== undefined && diagnostics.selectedLabel !== scene.select) {
    throw new Error(
      `${scene.name} shows the wrong selected option: ${String(diagnostics.selectedLabel)}`,
    );
  }
  if (diagnostics.infoText !== null && diagnostics.infoBesideList !== true) {
    throw new Error(
      `${scene.name}: the info panel overlaps the option list instead of docking beside it`,
    );
  }

  const image = await window.webContents.capturePage();
  await fs.writeFile(path.join(outputDirectory, `${scene.name}.png`), image.toPNG());

  if (scene.proveInert === true) {
    // The disabled another-Project entry stays LISTED but its apply is
    // inert: accepting it changes nothing in the document.
    const before = await window.webContents.executeJavaScript("window.completionProbeDoc()");
    const after = await window.webContents.executeJavaScript("window.completionProbeAccept()");
    if (before !== after) {
      throw new Error(
        `${scene.name}: applying the disabled another-Project entry changed the document`,
      );
    }
  }
}

app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      width: 1200,
      height: 800,
      show: false,
      webPreferences: { offscreen: true },
    });
    for (const scene of scenes) {
      await capture(window, scene);
    }
    window.destroy();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
