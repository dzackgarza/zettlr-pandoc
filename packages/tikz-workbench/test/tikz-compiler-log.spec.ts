import { strict as assert } from "node:assert";
import { tikzCompilerLogHeadline } from "../src/compiler-log";

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

  it("uses the real compiler error as the compact headline", function () {
    assert.equal(tikzCompilerLogHeadline(log), "! Undefined control sequence.");
  });

  it("selects the TeX failure after package-loading messages", function () {
    const fullLog = [
      "Package: infwarerr 2019/12/03 Providing info/warning/error messages",
      "Package pgfplots Warning: running in backwards compatibility mode",
      "! Undefined control sequence.",
      "l.19 \\badmacro",
    ].join("\n");
    assert.equal(tikzCompilerLogHeadline(fullLog), "! Undefined control sequence.");
  });

  it("uses a tool failure when TeX reports no bang-error", function () {
    const unusual = "pdflatex started\nbackend exited unexpectedly\nno PDF produced\n";
    assert.equal(tikzCompilerLogHeadline(unusual), "backend exited unexpectedly");
  });
});
