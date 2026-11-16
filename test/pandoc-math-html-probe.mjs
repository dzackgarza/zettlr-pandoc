// Renders an exported HTML file in the shipping Chromium and captures the
// post-MathJax DOM, a screenshot, and each request of the page to another
// machine (`<result.html>.requests.json`).
//
// Usage: node test/pandoc-math-html-probe.mjs <html-file> <screenshot.png> <result.html>

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openScene } from "./visual/scene.mjs";

const [inputFile, screenshotFile, resultFile] = process.argv.slice(-3);

const view = await openScene({
  width: 800,
  height: 600,
  userData: path.join(path.dirname(screenshotFile), "user-data"),
});

// Each request of the page that goes to another machine: a page that needs
// the network is no self-contained export.
const requestsToOtherMachines = [];
view.page.on("request", (request) => {
  const url = request.url();
  // An address of the page itself: a file, data of the page, or a blob that
  // a script of the page made (MathJax starts its speech worker from one).
  const ownAddress = ["file:", "data:", "about:", "blob:"].some((scheme) => url.startsWith(scheme));
  if (!ownAddress) {
    requestsToOtherMachines.push(url);
  }
});

await view.page.goto(pathToFileURL(inputFile).href);
await view.page.waitForFunction(
  () => document.querySelectorAll("mjx-container").length === 3,
  undefined,
  { timeout: 15000 },
);

const html = await view.page.evaluate(() => document.documentElement.outerHTML);
await view.page.screenshot({ path: screenshotFile });
await writeFile(resultFile, html);
await writeFile(`${resultFile}.requests.json`, JSON.stringify(requestsToOtherMachines));
await view.close();
