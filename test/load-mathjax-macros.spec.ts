import { strict as assert } from "assert";
import { mkdtemp, readFile, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { loadMathJaxMacros, seedDefaultMacros } from "source/app/util/load-mathjax-macros";

const VALID = "test/fixtures/mathjax-macros.json";
const MALFORMED = "test/fixtures/mathjax-macros.malformed.json";
const SHIPPED_DEFAULT = "static/mathjax-macros.json";

describe("loadMathJaxMacros()", function () {
  it("parses a MathJax macro file into validated definitions", async function () {
    const macros = await loadMathJaxMacros(VALID);

    assert.strictEqual(macros.RR, "\\mathbb{R}");
    assert.deepStrictEqual(macros.qty, ["\\left( {#1} \\right)", 1]);
    assert.deepStrictEqual(macros.optpair, ["\\left\\langle {#2}, {#1} \\right\\rangle", 2, ""]);
  });

  it("treats an absent macro file as no custom macros", async function () {
    assert.deepStrictEqual(await loadMathJaxMacros("test/fixtures/does-not-exist.json"), {});
  });

  it("fails loudly on a malformed macro definition instead of dropping it", async function () {
    await assert.rejects(loadMathJaxMacros(MALFORMED), /broken/);
  });

  it("ships a valid default macro set the loader accepts", async function () {
    const macros = await loadMathJaxMacros(SHIPPED_DEFAULT);
    assert.ok(Object.keys(macros).length > 0);
  });
});

describe("seedDefaultMacros()", function () {
  it("writes the default macro file when the config directory has none", async function () {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zettlr-macro-seed-"));
    await seedDefaultMacros(directory, SHIPPED_DEFAULT);

    const written = await readFile(path.join(directory, "mathjax-macros.json"), {
      encoding: "utf8",
    });
    assert.strictEqual(written, await readFile(SHIPPED_DEFAULT, { encoding: "utf8" }));
  });

  it("does not overwrite an existing macro file", async function () {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zettlr-macro-seed-"));
    const target = path.join(directory, "mathjax-macros.json");
    await writeFile(target, '{ "MINE": "\\\\mathbb{M}" }');
    await seedDefaultMacros(directory, SHIPPED_DEFAULT);

    assert.strictEqual(await readFile(target, { encoding: "utf8" }), '{ "MINE": "\\\\mathbb{M}" }');
  });
});
