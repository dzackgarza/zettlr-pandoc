"use strict";

const { app, BrowserWindow } = require("electron");
const fs = require("fs/promises");
const path = require("path");

const outputDirectory = process.argv[process.argv.length - 1];
const scenes = [
  // The resolved scenes capture BOTH hover frames (ledger C4): collapsed
  // (the excerpt genuinely clipped at its 10em bound) and expanded (a real
  // click on the production Expand toggle reveals the hidden content).
  {
    name: "reference-hover-light",
    scene: "resolved",
    dark: false,
    width: 1200,
    height: 800,
    expand: true,
  },
  {
    name: "reference-hover-dark",
    scene: "resolved",
    dark: true,
    width: 1200,
    height: 800,
    expand: true,
  },
  // The another-Project scenes hover the occurrence resolving into ProjectB
  // with projectRoots fed: the tooltip's Project-status row is the hover
  // surface of the outside-Project state (issue #1 Phase 7).
  {
    name: "reference-hover-another-project-light",
    scene: "another-project",
    dark: false,
    width: 1200,
    height: 800,
    expectStatus: "another-project",
  },
  {
    name: "reference-hover-another-project-dark",
    scene: "another-project",
    dark: true,
    width: 1200,
    height: 800,
    expectStatus: "another-project",
  },
];

async function screenshot(window, name) {
  const image = await window.webContents.capturePage();
  await fs.writeFile(path.join(outputDirectory, `${name}.png`), image.toPNG());
}

async function readDiagnostics(window) {
  return await window.webContents.executeJavaScript(`(() => {
    const tooltip = document.querySelector('.cm-tooltip.reference-hover-preview')
    const rect = tooltip === null ? null : tooltip.getBoundingClientRect()
    const excerpt = document.querySelector('[data-reference-excerpt]')
    const expand = document.querySelector('[data-reference-expand]')
    const status = document.querySelector('[data-reference-project-status]')
    return {
      hasTooltip: tooltip !== null,
      hasExcerpt: excerpt !== null,
      hasExpand: expand !== null,
      expandText: expand === null ? null : expand.textContent,
      excerptClipped: excerpt !== null && excerpt.scrollHeight > excerpt.clientHeight + 1,
      excerptClientHeight: excerpt === null ? null : excerpt.clientHeight,
      excerptExpanded: excerpt !== null && excerpt.classList.contains('expanded'),
      projectStatus: status === null ? null : status.getAttribute('data-reference-project-status'),
      projectStatusText: status === null ? null : status.textContent,
      rect: rect === null ? null : { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    }
  })()`);
}

function assertOnScreen(name, diagnostics) {
  const { rect, viewport } = diagnostics;
  if (
    rect.left < 0 ||
    rect.top < 0 ||
    rect.right > viewport.width ||
    rect.bottom > viewport.height
  ) {
    throw new Error(`${name} tooltip is clipped by the window: ${JSON.stringify(rect)}`);
  }
}

async function capture(window, scene) {
  const background = scene.dark ? "#2b2b2c" : "#ffffff";
  const foreground = scene.dark ? "#e5e7eb" : "#222222";
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; min-height: 100%; background: ${background}; color: ${foreground}; }
    body { padding: 28px; box-sizing: border-box; }
    #editor { max-width: 920px; margin: 0 auto; }
    .cm-editor { min-height: 620px; }
    .cm-scroller { padding: 18px 22px 60px; overflow-x: hidden; }
    .cm-content { overflow-wrap: anywhere; }
  </style></head><body data-dark="${scene.dark}" data-scene="${scene.scene}">
    <main id="editor"></main><script src="./reference-hover-visual-bundle.js"></script>
  </body></html>`;
  const pagePath = path.join(outputDirectory, `${scene.name}.html`);
  await fs.writeFile(pagePath, page);
  window.setSize(scene.width, scene.height);
  await window.loadFile(pagePath);
  await window.webContents.executeJavaScript("window.captureReady");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const collapsed = await readDiagnostics(window);
  console.log(scene.name, JSON.stringify(collapsed));
  if (!collapsed.hasTooltip || !collapsed.hasExcerpt || !collapsed.hasExpand) {
    throw new Error(`${scene.name} did not present the complete hover tooltip`);
  }
  assertOnScreen(scene.name, collapsed);

  if (scene.expectStatus !== undefined) {
    if (collapsed.projectStatus !== scene.expectStatus) {
      throw new Error(
        `${scene.name} shows the wrong Project status: ${String(collapsed.projectStatus)}`,
      );
    }
  } else if (collapsed.projectStatus !== null) {
    throw new Error(`${scene.name} fabricated a Project status without projectRoots`);
  }

  await screenshot(window, scene.name);

  if (scene.expand === true) {
    // The collapsed excerpt must actually clip, or the expanded frame would
    // show nothing new.
    if (!collapsed.excerptClipped || collapsed.excerptExpanded) {
      throw new Error(`${scene.name}'s collapsed excerpt is not genuinely clipped`);
    }
    await window.webContents.executeJavaScript(
      "document.querySelector('[data-reference-expand]').click()",
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    const expanded = await readDiagnostics(window);
    console.log(`${scene.name}-expanded`, JSON.stringify(expanded));
    if (!expanded.excerptExpanded || expanded.expandText !== "Collapse") {
      throw new Error(`${scene.name}'s Expand toggle did not expand the excerpt`);
    }
    if (expanded.excerptClientHeight <= collapsed.excerptClientHeight) {
      throw new Error(`${scene.name}'s expanded excerpt did not grow`);
    }
    assertOnScreen(`${scene.name}-expanded`, expanded);
    await screenshot(
      window,
      `${scene.name.replace("reference-hover-", "reference-hover-expanded-")}`,
    );
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
