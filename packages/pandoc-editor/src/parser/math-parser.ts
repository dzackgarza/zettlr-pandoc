/**
 * CodeMirror language mounting for math nodes emitted by the Pandoc Lezer fork.
 *
 * Grammar recognition lives in vendor/lezer-markdown-pandoc and is sourced
 * from Pandoc. This file deliberately contains no Markdown parsing rules; it
 * only overlays the TeX language on the already-recognized math payload.
 */

import { StreamLanguage } from "@codemirror/language";
import { stexMath } from "@codemirror/legacy-modes/mode/stex";
import { type ParseWrapper, parseMixed } from "@lezer/common";
import { mathDisplayForOpen } from "../util/math-delimiters";

const stexParser = StreamLanguage.define(stexMath).parser;

export function mathCodeParse(): ParseWrapper {
  return parseMixed((node, input) => {
    if (node.type.name !== "InlineCode" && node.type.name !== "FencedCode") {
      return null;
    }
    const mark = node.node.getChild("CodeMark");
    if (mark === null) {
      return null;
    }
    if (mathDisplayForOpen(input.read(mark.from, mark.to)) === null) {
      return null;
    }
    return {
      parser: stexParser,
      overlay: (child) => child.type.name === "CodeText",
    };
  });
}
