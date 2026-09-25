import { strict as assert } from "node:assert";
import { tikzCompilerLogExcerpt, tikzCompilerLogHeadline } from "@common/util/tikz-compiler-log";

describe("TikZ compiler-log presentation", function () {
  const log = [
    "[tikzcd-pdflatex-log-begin]",
    "This is pdfTeX, Version 3.141592653",
    "(/usr/share/texlive/texmf-dist/tex/latex/base/article.cls",
    "! Undefined control sequence.",
    "l.42 \\thisMacroDoesNotExist",
    "I have no idea what this control sequence is.",
    "",
    "Here is how much of TeX's memory you used:",
    "[tikzcd-pdflatex-log-end]",
  ].join("\n");

  it("extracts the actual TeX error block without machine framing", function () {
    const excerpt = tikzCompilerLogExcerpt(log);
    assert.match(excerpt, /Undefined control sequence/u);
    assert.match(excerpt, /l\.42 \\thisMacroDoesNotExist/u);
    assert.doesNotMatch(excerpt, /tikzcd-pdflatex-log/u);
  });

  it("uses the real compiler error as the compact headline", function () {
    assert.equal(tikzCompilerLogHeadline(log), "! Undefined control sequence.");
  });

  it("falls back to actual trailing output when a compiler emits no recognizable bang-error", function () {
    const unusual = "pdflatex started\nbackend exited unexpectedly\nno PDF produced\n";
    assert.match(tikzCompilerLogExcerpt(unusual), /backend exited unexpectedly/u);
  });
});
