/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikZ / tikzcd editor languages
 * CVM-Role:        Language support
 * License:         GNU GPL v3
 *
 * Description:     Integrates the MIT-licensed @tikz-editor/lang-tikz Lezer
 *                  grammar into Markdown code fences and raw TikZ environments.
 *                  tikzcd is a distinct matrix/arrow DSL, so it gets a small
 *                  dedicated stream language rather than being mislabeled as
 *                  ordinary TikZ path syntax.
 *
 * END HEADER
 */

import { StreamLanguage, type StreamParser, type StringStream } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { rawLatexEnvironmentAtStart } from "@common/util/raw-latex-block";
import { type ParseWrapper, parseMixed } from "@lezer/common";
import { tikzLanguage } from "@tikz-editor/lang-tikz";

interface TikzCdState {
  optionDepth: number;
  inMath: boolean;
}

function matches(stream: StringStream, pattern: string | RegExp): boolean {
  const result = stream.match(pattern);
  return result !== false && result !== null;
}

const tikzCdParser: StreamParser<TikzCdState> = {
  name: "tikzcd",
  startState: () => ({ optionDepth: 0, inMath: false }),
  // Make tikzcd a real CodeMirror language surface rather than merely a
  // highlighter. The editor's standard Mod-/ command reads commentTokens from
  // the active nested language, so raw and fenced tikzcd blocks can comment or
  // uncomment one or many selected lines with TeX's '%' line comment marker.
  languageData: {
    commentTokens: { line: "%" },
  },
  token: (stream: StringStream, state: TikzCdState): string | null => {
    if (stream.eatSpace()) {
      return null;
    }

    if (matches(stream, /^%.*/)) {
      return "lineComment";
    }

    if (matches(stream, /^\\begin\{tikzcd\}/) || matches(stream, /^\\end\{tikzcd\}/)) {
      return "keyword";
    }

    if (matches(stream, /^\\(?:arrow|ar)\b/)) {
      return "keyword";
    }

    if (matches(stream, /^\\\\/)) {
      return "separator";
    }

    if (matches(stream, /^\\(?:[A-Za-z@]+|.)/)) {
      return state.inMath ? "macroName" : "meta";
    }

    if (matches(stream, /^\$\$/) || matches(stream, /^\$/)) {
      state.inMath = !state.inMath;
      return "regexp";
    }

    if (matches(stream, /^&/)) {
      return "separator";
    }

    if (matches(stream, /^\[/)) {
      state.optionDepth++;
      return "squareBracket";
    }
    if (matches(stream, /^\]/)) {
      state.optionDepth = Math.max(0, state.optionDepth - 1);
      return "squareBracket";
    }

    if (state.optionDepth > 0) {
      if (matches(stream, /^"(?:[^"\\]|\\.)*"/)) {
        return "string";
      }
      if (matches(stream, /^'(?![A-Za-z])/)) {
        return "modifier";
      }
      if (matches(stream, /^(?:[rlud]+)(?=\s*(?:,|\]|$))/)) {
        return "typeName";
      }
      if (
        matches(
          stream,
          /^(?:bend\s+(?:left|right)|shift\s+(?:left|right)|crossing\s+over|phantom|swap|near\s+start|near\s+end|description|sloped|dashed|dotted|hook|two\s+heads|tail)(?=\s*(?:=|,|\]|$))/i,
        )
      ) {
        return "propertyName";
      }
      if (matches(stream, /^[A-Za-z][A-Za-z0-9 _.-]*(?=\s*=)/)) {
        return "propertyName";
      }
      if (matches(stream, /^=/)) {
        return "operator";
      }
      if (matches(stream, /^,/)) {
        return "punctuation";
      }
      if (matches(stream, /^-?\d+(?:\.\d+)?/)) {
        return "number";
      }
      if (matches(stream, /^[^,\]=]+/)) {
        return "variableName";
      }
    }

    if (matches(stream, /^-?\d+(?:\.\d+)?/)) {
      return "number";
    }
    if (matches(stream, /^[{}()]/)) {
      return "bracket";
    }

    stream.next();
    return null;
  },
};

export const tikzCdLanguage = StreamLanguage.define(tikzCdParser);
export { tikzLanguage };

const RAW_TIKZ_ENVIRONMENTS = new Map([
  ["tikzpicture", tikzLanguage],
  ["tikzcd", tikzCdLanguage],
] as const);
const rawTexLanguage = StreamLanguage.define(stex);

/**
 * Mount language support into a structurally recognized raw LaTeX block.
 * The block parser owns extent; this wrapper owns only syntax highlighting.
 */
export function rawLatexLanguageParse(): ParseWrapper {
  return parseMixed((node, input) => {
    if (node.type.name !== "RawBlock") {
      return null;
    }
    const environment = rawLatexEnvironmentAtStart(input.read(node.from, node.to));
    if (environment === null) {
      return null;
    }
    const language =
      RAW_TIKZ_ENVIRONMENTS.get(environment as "tikzpicture" | "tikzcd") ?? rawTexLanguage;
    return {
      parser: language.parser,
      overlay: (child) => child.type.name === "RawBlockContent",
    };
  });
}
