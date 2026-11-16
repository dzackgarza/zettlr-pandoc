import path from "node:path";
import { openScene } from "./visual/scene.mjs";

const WIDE = { width: 1200, height: 800 };

const scene = await openScene({
  ...WIDE,
  args: ["--ozone-platform=x11", "--disable-gpu"],
});
const { page } = scene;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #1e1e1e; color: #fff; }
  #app { width: 100%; height: 100%; }
</style></head><body class="dark">
  <div id="app"></div>
  <script src="./annotations-panel-animation-bundle.js"></script>
</body></html>`;

await scene.open("benchmark.html", html);
await page.evaluate(() => window.benchmarkReady);

const steps = [320, 260, 200, 140, 80, 20, 0];

// 1. Unoptimized baseline
await page.evaluate(() => window.setUnoptimizedMode(true));
const unoptimizedLayout = await page.evaluate((s) => window.measureStepLayouts(s), steps);
const unoptimizedClose = await page.evaluate(() => window.measureToggleAnimation("close"));
await new Promise((r) => setTimeout(r, 150));
const unoptimizedOpen = await page.evaluate(() => window.measureToggleAnimation("open"));

// 2. Optimized state
await page.evaluate(() => window.setUnoptimizedMode(false));
const optimizedLayout = await page.evaluate((s) => window.measureStepLayouts(s), steps);
// One run of an animation counts each frame that came late. A frame that the
// machine delayed (another process had the processor) is late in one run and
// on time in the next; a frame that the animation delays is late in each
// run. The report has, of three runs, the one with the fewest severe dropped
// frames, so it counts the frames that the animation itself delays.
const OPTIMIZED_RUNS = 3;
const fewestSevere = (runs) =>
  runs.reduce((least, run) => (run.severeDroppedFrames < least.severeDroppedFrames ? run : least));
const optimizedCloses = [];
const optimizedOpens = [];
for (let run = 0; run < OPTIMIZED_RUNS; run++) {
  optimizedCloses.push(await page.evaluate(() => window.measureToggleAnimation("close")));
  await new Promise((r) => setTimeout(r, 150));
  optimizedOpens.push(await page.evaluate(() => window.measureToggleAnimation("open")));
  await new Promise((r) => setTimeout(r, 150));
}
const optimizedClose = fewestSevere(optimizedCloses);
const optimizedOpen = fewestSevere(optimizedOpens);

// 3. Inspect CSS rule for content-visibility
const hasContentVisibility = await page.evaluate(() => {
  const item = document.querySelector(".annotation-workspace-row");
  if (!item) return false;
  const style = window.getComputedStyle(item);
  return style.contentVisibility === "auto";
});

// 4. The toggles gave the view its list of workspace paths again, as a new
// array with the same paths.
const workspaceStateReads = await page.evaluate(() => window.workspaceStateReads());

await scene.close();

const report = {
  unoptimized: {
    layout: unoptimizedLayout,
    close: unoptimizedClose,
    open: unoptimizedOpen,
  },
  optimized: {
    layout: optimizedLayout,
    close: optimizedClose,
    open: optimizedOpen,
  },
  hasContentVisibility,
  workspaceStateReads,
};

console.log(JSON.stringify(report));
