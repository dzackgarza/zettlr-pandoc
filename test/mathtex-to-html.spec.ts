/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        MathTeX HTML Rendering Test
 * CVM-Role:        Test
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file tests MathJax CommonHTML rendering.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { resolve } from "path";
import { loadMathJaxMacros } from "source/app/util/load-mathjax-macros";
import {
  initializeMathJax,
  mathJaxToElem,
  mathJaxToHTML,
} from "source/common/util/mathtex-to-html";

// The app ships no macros; this test supplies its own example fixture file and
// loads it through the real loader.
const FIXTURE = "test/fixtures/mathjax-macros.json";

it("requires initialization before conversion", function () {
  assert.throws(() => mathJaxToHTML("\\RR", "inline"), Error);
});

it("registers updater IPC only after its boot initialization", function () {
  const source = readFileSync(resolve("source/app/service-providers/updates/index.ts"), "utf8");
  const bootAt = source.indexOf("async boot(): Promise<void>");
  // Without this the slice below is the whole file, and the ordering it checks
  // is read off two positions that have nothing to do with boot().
  assert.notEqual(bootAt, -1, "the updater provider must declare boot()");
  const boot = source.slice(bootAt);

  assert.ok(boot.indexOf("await initializeMathJax(") < boot.indexOf("this._registerIpcHandler()"));
});

it("renders updater Markdown with the lite adaptor without a global document", function () {
  this.timeout(30000);

  const html = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type",
      "module",
      "--eval",
      `import { initializeMathJax } from './source/common/util/mathtex-to-html.ts'
import { loadMathJaxMacros } from './source/app/util/load-mathjax-macros.ts'
import { md2html } from './source/common/modules/markdown-utils/markdown-to-html.ts'
await initializeMathJax(await loadMathJaxMacros('test/fixtures/mathjax-macros.json'))
process.stdout.write(await md2html('$$\\\\RR$$', { onCitation: () => undefined, zknLinkFormat: 'link|title' }))`,
    ],
    { encoding: "utf8" },
  );

  assert.match(html, /<mjx-container[^>]*display="true"/);
  assert.match(html, /ℝ/);
});

describe("Utility#mathJaxToHTML()", function () {
  before(async function () {
    // Full-stylesheet initialization loads every dynamic font module once.
    this.timeout(30000);
    await initializeMathJax(await loadMathJaxMacros(FIXTURE));
  });

  it("serializes configured macros and mhchem as CommonHTML display math", function () {
    // \RR (zero-arg) and \qty (one-arg) come from the fixture macro file;
    // \ce exercises mhchem.
    const html = mathJaxToHTML("\\RR + \\qty{x} + \\ce{H2O}", "display");

    const rendered = document.createElement("div");
    rendered.innerHTML = html;

    assert.equal(rendered.querySelector("mjx-container")?.getAttribute("display"), "true");
    assert.match(rendered.textContent ?? "", /ℝ/);
    assert.match(rendered.textContent ?? "", /\(𝑥\)/);
    assert.equal(rendered.querySelector("mjx-msub")?.textContent, "𝐴2");

    const stylesheet = document.getElementById("MJX-CHTML-styles");
    assert.ok(stylesheet);
    assert.match(
      stylesheet.textContent ?? "",
      /url\("http:\/\/localhost:3000\/mathjax\/mjx-ncm-ds\.woff2"\)/,
    );
    assert.doesNotMatch(stylesheet.textContent ?? "", /cdn\.jsdelivr\.net|@mathjax\//);
  });

  it("inserts CommonHTML into the supplied element synchronously", function () {
    const element = document.createElement("div");

    mathJaxToElem("\\RR", element, "inline");

    assert.equal(element.querySelector("mjx-container")?.getAttribute("jax"), "CHTML");
    assert.match(element.textContent ?? "", /ℝ/);
  });
});
