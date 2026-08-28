"use strict";

// Captures the REAL ButtonControl-based Back/Forward navigation controls
// (issue #1 Phase 5; ledger C4) in both enabled and disabled states, light
// and dark. The page installs the window.ipc recorder seam BEFORE the
// bundle evaluates (WindowToolbar and the i18n module capture window.ipc at
// import/mount time), exactly as the reference-navigation probe does; it
// records outgoing requests only and simulates nothing back.

const { app, BrowserWindow } = require("electron");
const fs = require("fs/promises");
const path = require("path");

const outputDirectory = process.argv[process.argv.length - 1];
const scenes = [
  {
    name: "navigation-controls-enabled-light",
    scene: "enabled",
    dark: false,
    width: 480,
    height: 120,
  },
  {
    name: "navigation-controls-enabled-dark",
    scene: "enabled",
    dark: true,
    width: 480,
    height: 120,
  },
  {
    name: "navigation-controls-disabled-light",
    scene: "disabled",
    dark: false,
    width: 480,
    height: 120,
  },
  {
    name: "navigation-controls-disabled-dark",
    scene: "disabled",
    dark: true,
    width: 480,
    height: 120,
  },
];

async function capture(window, scene) {
  const background = scene.dark ? "#1d2024" : "#e9eaec";
  const foreground = scene.dark ? "#e5e7eb" : "#222222";
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body, #app { margin: 0; width: 100%; min-height: 100%; background: ${background}; color: ${foreground}; }
  </style></head><body class="${scene.dark ? "dark" : ""}" data-scene="${scene.scene}">
    <main id="app"></main><script>
    window.__ipcInvocations = []
    window.ipc = {
      invoke: (channel, ...args) => {
        window.__ipcInvocations.push({ channel, args })
        return Promise.resolve(undefined)
      },
      on: () => {},
      send: () => {},
      sendSync: () => { throw new Error('sendSync is unavailable in the navigation-controls capture') }
    }
    </script><script src="./reference-navigation-controls-bundle.js"></script>
  </body></html>`;
  const pagePath = path.join(outputDirectory, `${scene.name}.html`);
  await fs.writeFile(pagePath, page);
  window.setSize(scene.width, scene.height);
  await window.loadFile(pagePath);
  await window.webContents.executeJavaScript("window.captureReady");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const diagnostics = await window.webContents.executeJavaScript(`(() => {
    const back = document.querySelector('#toolbar-previous-file')
    const forward = document.querySelector('#toolbar-next-file')
    const iconRendered = icon => icon !== null && icon.shadowRoot !== null && icon.shadowRoot.querySelector('svg') !== null
    return {
      hasToolbar: document.querySelector('#toolbar') !== null,
      backPresent: back !== null,
      forwardPresent: forward !== null,
      backTitle: back === null ? null : back.getAttribute('title'),
      forwardTitle: forward === null ? null : forward.getAttribute('title'),
      backDisabled: back === null ? null : back.disabled,
      forwardDisabled: forward === null ? null : forward.disabled,
      backOpacity: back === null ? null : getComputedStyle(back).opacity,
      forwardOpacity: forward === null ? null : getComputedStyle(forward).opacity,
      backArrowLeft: back === null ? null : back.querySelector('cds-icon[shape="arrow"][direction="left"]') !== null,
      forwardArrowRight: forward === null ? null : forward.querySelector('cds-icon[shape="arrow"][direction="right"]') !== null,
      backIconRendered: back === null ? false : iconRendered(back.querySelector('cds-icon')),
      forwardIconRendered: forward === null ? false : iconRendered(forward.querySelector('cds-icon')),
    }
  })()`);
  console.log(scene.name, JSON.stringify(diagnostics));

  if (!diagnostics.hasToolbar || !diagnostics.backPresent || !diagnostics.forwardPresent) {
    throw new Error(`${scene.name} did not mount the toolbar navigation controls`);
  }
  if (
    diagnostics.backTitle !== "Navigate back" ||
    diagnostics.forwardTitle !== "Navigate forward"
  ) {
    throw new Error(`${scene.name} carries the wrong control titles`);
  }
  if (
    !diagnostics.backArrowLeft ||
    !diagnostics.forwardArrowRight ||
    !diagnostics.backIconRendered ||
    !diagnostics.forwardIconRendered
  ) {
    throw new Error(`${scene.name} did not render the directional arrow icons`);
  }
  const expectDisabled = scene.scene === "disabled";
  if (
    diagnostics.backDisabled !== expectDisabled ||
    diagnostics.forwardDisabled !== expectDisabled
  ) {
    throw new Error(`${scene.name} has the wrong disabled state: ${JSON.stringify(diagnostics)}`);
  }
  // The disabled presentation must be visually distinct (ButtonControl's
  // :disabled rule dims to opacity 0.4).
  if (
    expectDisabled &&
    (Number(diagnostics.backOpacity) >= 1 || Number(diagnostics.forwardOpacity) >= 1)
  ) {
    throw new Error(`${scene.name}'s disabled controls are not visually dimmed`);
  }

  const image = await window.webContents.capturePage();
  await fs.writeFile(path.join(outputDirectory, `${scene.name}.png`), image.toPNG());
}

app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      width: 480,
      height: 120,
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
