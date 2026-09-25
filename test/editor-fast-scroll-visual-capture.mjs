import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { openScene, outputDirectory } from "./visual/scene.mjs";

await mkdir(outputDirectory, { recursive: true });

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #fff; }
  #editor { width: 920px; height: 620px; margin: 20px auto; border: 1px solid #ccc; }
  .cm-editor { height: 100%; font-size: 16px; line-height: 1.45; }
  .cm-scroller { overflow-y: auto; overflow-x: hidden; }
</style></head><body><main id="editor"></main>
<script>
window.ipc = { on: () => () => {}, invoke: async () => undefined, send: () => {}, sendSync: () => undefined }
window.config = { get: () => undefined, set: () => {} }
window.getCitationCallback = () => citations => citations.map(citation => citation.id).join('; ')
</script>
<script src="./fast-scroll-visual-bundle.js"></script></body></html>`;

const scene = await openScene({
  width: 1000,
  height: 700,
  args: ["--ozone-platform=x11", "--disable-gpu"],
});
try {
  await scene.open("fast-scroll.html", html);
  await scene.page.evaluate(() => window.captureReady);
  const scroller = scene.page.locator(".cm-scroller");
  await scroller.hover();

  const samples = [];
  for (let index = 0; index < 8; index += 1) {
    await scene.page.mouse.wheel(0, 4200);
    await scene.page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const sample = await scene.page.evaluate(() => window.fastScrollCoverage());
    samples.push(sample);
    if (sample.visibleLineCount === 0) {
      throw new Error(
        `fast scroll exposed a viewport with no rendered lines: ${JSON.stringify(sample)}`,
      );
    }
    // A downward scroll should leave multiple screen-heights of already drawn
    // content ahead. 1500px is deliberately below the patched 5000px target
    // to allow block/widget geometry and viewport-boundary rounding.
    if (sample.renderedBelowPx < 1500) {
      throw new Error(
        `fast scroll exhausted CodeMirror's forward render buffer: ${JSON.stringify(sample)}`,
      );
    }
  }

  console.log(JSON.stringify({ samples }, null, 2));
  await scene.capture("fast-scroll-coverage");
} finally {
  await scene.close();
}
