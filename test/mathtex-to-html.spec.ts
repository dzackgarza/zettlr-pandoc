import { strict as assert } from "assert";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { resolve } from "path";
import { loadMathJaxMacros } from "source/app/util/load-mathjax-macros";
import {
  __mathJaxRenderCacheSizeForTests,
  __resetMathJaxRenderCacheForTests,
  initializeMathJax,
  mathJaxToElem,
  mathJaxToHTML,
} from "source/common/util/mathtex-to-html";

const FIXTURE = "test/fixtures/mathjax-macros.json";

it("requires initialization before conversion", function () {
  this.timeout(30000);

  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type",
          "module",
          "--eval",
          `import { mathJaxToHTML } from './source/common/util/mathtex-to-html.ts'
mathJaxToHTML('\\\\RR', 'inline')`,
        ],
        { encoding: "utf8", stdio: "pipe" },
      ),
    /MathJax must be initialized before rendering/,
  );
});

it("registers updater IPC only after its boot initialization", function () {
  const source = readFileSync(resolve("source/app/service-providers/updates/index.ts"), "utf8");
  const bootAt = source.search(/async boot\s*\(\): Promise<void>/);
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
await initializeMathJax(await loadMathJaxMacros('test/fixtures/mathjax-macros.json'), {})
process.stdout.write(await md2html('$$\\\\RR$$', { onCitation: () => undefined, zknLinkFormat: 'link|title' }))`,
    ],
    { encoding: "utf8" },
  );

  assert.match(html, /<mjx-container[^>]*display="true"/);
  assert.match(html, /ℝ/);
});

it("renders each form of a paired delimiter of ~/.pandoc as mathtools does", function () {
  this.timeout(60000);

  const pairs = [
    ["\\qty{\\frac{a}{b}}", "\\mathopen{(}\\frac{a}{b}\\mathclose{)}"],
    ["\\qty*{\\frac{a}{b}}", "\\mathopen{}\\mathclose{\\left(\\frac{a}{b}\\right)}"],
    ["\\qty[\\big]{\\frac{a}{b}}", "\\mathopen{\\bigl(}\\frac{a}{b}\\mathclose{\\bigr)}"],
    ["\\ceil*{\\frac{a}{b}}", "\\mathopen{}\\mathclose{\\left\\lceil\\frac{a}{b}\\right\\rceil}"],
    ["a \\coloneqq b", "a \\vcentercolon\\mathrel{\\mkern-1.2mu}= b"],
  ];
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type",
      "module",
      "--eval",
      `import { homedir } from 'os'
import { initializeMathJax, mathJaxToHTML } from './source/common/util/mathtex-to-html.ts'
import { loadCanonicalMathJaxMacros, loadCanonicalMathJaxPairedDelimiters } from './source/app/util/load-mathjax-macros.ts'
await initializeMathJax(await loadCanonicalMathJaxMacros(homedir()), await loadCanonicalMathJaxPairedDelimiters(homedir()))
const pairs = JSON.parse(process.argv[1])
const page = (tex) => mathJaxToHTML(tex, 'display').replace(/ data-latex="[^"]*"|<\\/?mjx-TeXAtom[^>]*>/g, '')
process.stdout.write(JSON.stringify(pairs.map(([call, meaning]) => [call, page(call) === page(meaning) && !/color: red/.test(page(call))])))`,
      JSON.stringify(pairs),
    ],
    { encoding: "utf8" },
  );

  assert.deepEqual(
    JSON.parse(output),
    pairs.map(([call]) => [call, true]),
  );
});

function textOf(node: Node): string {
  const text = node.textContent;
  assert.ok(text !== null, `expected ${node.nodeName} to carry text content`);
  return text;
}

describe("Utility#mathJaxToHTML()", function () {
  before(async function () {
    this.timeout(30000);
    await initializeMathJax(await loadMathJaxMacros(FIXTURE), {});
  });

  it("serializes configured macros and mhchem as CommonHTML display math", function () {
    const html = mathJaxToHTML("\\RR + \\qty{x} + \\ce{H2O}", "display");

    const rendered = new DOMParser().parseFromString(html, "text/html").body;

    assert.equal(rendered.querySelector("mjx-container")?.getAttribute("display"), "true");
    assert.match(textOf(rendered), /ℝ/);
    assert.match(textOf(rendered), /\(𝑥\)/);
    assert.equal(rendered.querySelector("mjx-msub")?.textContent, "𝐴2");

    const stylesheet = document.getElementById("MJX-CHTML-styles");
    assert.ok(stylesheet);
    assert.match(
      textOf(stylesheet),
      /url\("http:\/\/localhost:3000\/mathjax\/mjx-ncm-ds\.woff2"\)/,
    );
    assert.doesNotMatch(textOf(stylesheet), /cdn\.jsdelivr\.net|@mathjax\//);
  });

  it("renders the MathJax boldsymbol package instead of an undefined control sequence", function () {
    const html = mathJaxToHTML("\\boldsymbol{\\iota}_L", "inline");
    const rendered = new DOMParser().parseFromString(html, "text/html").body;

    assert.doesNotMatch(textOf(rendered), /\\boldsymbol/);
    assert.equal(rendered.querySelector('mjx-mtext[style*="color: red"]'), null);
  });

  it("inserts CommonHTML into the supplied element synchronously", function () {
    const element = document.createElement("div");

    mathJaxToElem("\\RR", element, "inline");

    assert.equal(element.querySelector("mjx-container")?.getAttribute("jax"), "CHTML");
    assert.match(textOf(element), /ℝ/);
  });

  it("memoizes repeated browser equations while cloning the cached DOM", function () {
    __resetMathJaxRenderCacheForTests();
    const first = document.createElement("div");
    const second = document.createElement("div");

    mathJaxToElem("x^2", first, "inline");
    assert.equal(__mathJaxRenderCacheSizeForTests(), 1);
    mathJaxToElem("x^2", second, "inline");
    assert.equal(__mathJaxRenderCacheSizeForTests(), 1);

    assert.equal(first.innerHTML, second.innerHTML);
    assert.notEqual(first.firstElementChild, second.firstElementChild);

    mathJaxToElem("x^2", second, "display");
    assert.equal(__mathJaxRenderCacheSizeForTests(), 2);
  });

  it("keeps each equation of a long document for the next pass over it", function () {
    this.timeout(30000);
    __resetMathJaxRenderCacheForTests();
    const equations = Array.from({ length: 500 }, (_, i) => `L_{${i}} \\oplus U`);
    const pass = (): string[] =>
      equations.map((equation) => {
        const element = document.createElement("div");
        mathJaxToElem(equation, element, "inline");
        return element.innerHTML;
      });

    const first = pass();
    assert.equal(__mathJaxRenderCacheSizeForTests(), equations.length);
    assert.deepEqual(pass(), first);
    assert.equal(__mathJaxRenderCacheSizeForTests(), equations.length);
  });
});
