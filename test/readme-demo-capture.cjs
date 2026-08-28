"use strict";

// Replays the scripted README demo scenes (readme-demo-entry.ts) in an
// offscreen Electron window, writing one PNG frame per step plus an ffconcat
// timing file per scene. scripts/build-readme-demos.sh assembles the GIFs.

const { app, BrowserWindow } = require("electron");
const fs = require("fs/promises");
const path = require("path");

const outputDirectory = process.argv[process.argv.length - 1];
const scenes = [
  { name: "math-typing", scene: "math", width: 920, height: 600 },
  { name: "amsthm-typing", scene: "amsthm", width: 920, height: 640 },
  { name: "review-flow", scene: "review", width: 980, height: 640 },
  // A single-frame still: the theorem-environment sampler for the README
  // gallery. build-readme-demos.sh leaves it out of the GIF loop.
  { name: "env-gallery", scene: "gallery", width: 920, height: 700 },
];

async function capture(window, scene) {
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; min-height: 100%; background: #ffffff; color: #222222; }
    body { padding: 22px; box-sizing: border-box; }
    #editor { max-width: 860px; margin: 0 auto; }
    .cm-editor { min-height: ${scene.height - 60}px; font-size: 16px; line-height: 1.5; }
    .cm-scroller { padding: 16px 20px 40px; overflow-x: hidden; }
    .cm-content { overflow-wrap: anywhere; }
    .review-diff-active button.cm-review-diff-control {
      white-space: nowrap;
      min-width: 64px;
      height: 24px;
      padding: 0 8px;
      border: 1px solid transparent;
      border-radius: 4px;
      color: #ffffff;
      font: inherit;
      font-size: 12px;
      line-height: 22px;
      cursor: pointer;
    }
    .review-diff-active button.cm-review-diff-control.accept {
      background-color: var(--zettlr-editor-review-accept-bg);
      border-color: var(--zettlr-editor-review-accept-border);
    }
    .review-diff-active button.cm-review-diff-control.reject {
      background-color: var(--zettlr-editor-review-reject-bg);
      border-color: var(--zettlr-editor-review-reject-border);
    }
  </style></head><body data-scene="${scene.scene}">
    <main id="editor"></main><script src="../readme-demo-bundle.js"></script>
  </body></html>`;
  // Pages live one level below the output directory: the production MathJax
  // setup resolves its webfonts at ../mathjax relative to the page (the
  // webpack build copies them there), so the driver mirrors that layout.
  const pagesDirectory = path.join(outputDirectory, "pages");
  await fs.mkdir(pagesDirectory, { recursive: true });
  const pagePath = path.join(pagesDirectory, `${scene.name}.html`);
  await fs.writeFile(pagePath, page);
  const framesDirectory = path.join(outputDirectory, scene.name);
  await fs.mkdir(framesDirectory, { recursive: true });

  window.setSize(scene.width, scene.height);
  await window.loadFile(pagePath);
  await window.webContents.executeJavaScript("window.captureReady");
  const stepCount = await window.webContents.executeJavaScript("window.demoStepCount");
  if (stepCount === 0) {
    throw new Error(`${scene.name} scripted zero steps`);
  }

  const concat = ["ffconcat version 1.0"];
  const writeFrame = async (index, hold) => {
    // Two animation frames + a short settle so MathJax/widget DOM lands
    // before the page is rasterized.
    await window.webContents.executeJavaScript(
      "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const image = await window.webContents.capturePage();
    const name = `frame-${String(index).padStart(4, "0")}.png`;
    await fs.writeFile(path.join(framesDirectory, name), image.toPNG());
    concat.push(`file '${scene.name}/${name}'`, `duration ${hold}`);
    return name;
  };

  await writeFrame(0, 0.8);
  let lastFrame = null;
  for (let i = 0; i < stepCount; i++) {
    const hold = await window.webContents.executeJavaScript(`window.runDemoStep(${i})`);
    lastFrame = await writeFrame(i + 1, hold);
  }
  // The concat demuxer ignores the final duration unless the last file is
  // listed a second time.
  concat.push(`file '${scene.name}/${lastFrame}'`);
  await fs.writeFile(
    path.join(outputDirectory, `${scene.name}.ffconcat`),
    concat.join("\n") + "\n",
  );
  console.log(`${scene.name}: ${stepCount + 1} frames`);
}

app
  .whenReady()
  .then(async () => {
    const fontsDirectory = path.join(outputDirectory, "mathjax");
    for (const fontPackage of ["mathjax-newcm-font", "mathjax-mhchem-font-extension"]) {
      await fs.cp(
        path.join(__dirname, "..", "node_modules", "@mathjax", fontPackage, "chtml", "woff2"),
        fontsDirectory,
        { recursive: true },
      );
    }
    const window = new BrowserWindow({
      width: 980,
      height: 640,
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
