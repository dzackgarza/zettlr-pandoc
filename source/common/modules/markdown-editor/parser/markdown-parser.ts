/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Markdown Parser
 * CVM-Role:        Lezer Parser
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This is the main parser for Markdown documents. Most of the
 *                  code in here is boilerplate that adds various code
 *                  highlighting languages to the parser.
 *
 * END HEADER
 */

import { angular } from "@codemirror/lang-angular";
import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { jinja } from "@codemirror/lang-jinja";
import { json } from "@codemirror/lang-json";
import { less } from "@codemirror/lang-less";
import { lezer } from "@codemirror/lang-lezer";
import { liquid } from "@codemirror/lang-liquid";
// Import all the languages, first the "new" ones
import { commonmarkLanguage, markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { php } from "@codemirror/lang-php";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sass } from "@codemirror/lang-sass";
import { sql } from "@codemirror/lang-sql";
import { vue } from "@codemirror/lang-vue";
import { wast } from "@codemirror/lang-wast";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import {
  foldNodeProp,
  type Language,
  type LanguageDescription,
  type LanguageSupport,
  StreamLanguage,
} from "@codemirror/language";
import { styleTags } from "@lezer/highlight";
import { Pandoc, type ZknLinkParserConfig } from "@lezer/markdown";
// Now from the legacy modes package
import { c, csharp, dart, kotlin, objectiveC, scala } from "@codemirror/legacy-modes/mode/clike";
import { clojure } from "@codemirror/legacy-modes/mode/clojure";
import { cobol } from "@codemirror/legacy-modes/mode/cobol";
import { commonLisp } from "@codemirror/legacy-modes/mode/commonlisp";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { elm } from "@codemirror/legacy-modes/mode/elm";
import { fortran } from "@codemirror/legacy-modes/mode/fortran";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { julia } from "@codemirror/legacy-modes/mode/julia";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { fSharp } from "@codemirror/legacy-modes/mode/mllike";
import { octave } from "@codemirror/legacy-modes/mode/octave";
import { pascal } from "@codemirror/legacy-modes/mode/pascal";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { r } from "@codemirror/legacy-modes/mode/r";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { scheme } from "@codemirror/legacy-modes/mode/scheme";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { smalltalk } from "@codemirror/legacy-modes/mode/smalltalk";
import { sparql } from "@codemirror/legacy-modes/mode/sparql";
import { stex, stexMath } from "@codemirror/legacy-modes/mode/stex";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { tcl } from "@codemirror/legacy-modes/mode/tcl";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { turtle } from "@codemirror/legacy-modes/mode/turtle";
import { vb } from "@codemirror/legacy-modes/mode/vb";
import { verilog } from "@codemirror/legacy-modes/mode/verilog";
import { vhdl } from "@codemirror/legacy-modes/mode/vhdl";
// Third-party parsers
import { nix } from "@replit/codemirror-lang-nix";
import { elixirLanguage } from "codemirror-lang-elixir";
import { hcl } from "codemirror-lang-hcl";
import { customTags } from "../util/custom-tags";

// Editor-only parser adapters. Pandoc Markdown grammar lives in the vendored
// @lezer/markdown fork; nothing below redefines Pandoc syntax.
import { yamlCodeParse } from "./frontmatter-parser";
import { highlightParser } from "./highlight-parser";
import { mathCodeParse } from "./math-parser";
import { rawLatexLanguageParse, tikzCdLanguage, tikzLanguage } from "./tikz-parser";
import { zknTagParser } from "./zkn-tag-parser";

const codeLanguages: Array<{ mode: Language | LanguageDescription | null; selectors: string[] }> = [
  { mode: markdownLanguage, selectors: ["markdown", "md"] },
  { mode: angular().language, selectors: ["angular"] },
  { mode: cpp().language, selectors: ["c++", "cpp"] },
  { mode: css().language, selectors: ["css"] },
  { mode: go().language, selectors: ["go"] },
  { mode: html().language, selectors: ["html"] },
  { mode: java().language, selectors: ["java"] },
  { mode: javascript().language, selectors: ["javascript", "js", "node"] },
  { mode: javascript({ typescript: true }).language, selectors: ["typescript", "ts"] },
  { mode: jinja().language, selectors: ["jinja"] },
  { mode: json().language, selectors: ["json"] },
  { mode: less().language, selectors: ["less"] },
  { mode: lezer().language, selectors: ["lezer"] },
  { mode: liquid().language, selectors: ["liquid"] },
  { mode: nix().language, selectors: ["nix"] },
  // NOTE: The PHP parser usually expects the PHP code to start with <?, unless "plain" is set
  { mode: php({ plain: true }).language, selectors: ["php"] },
  { mode: python().language, selectors: ["python", "py"] },
  { mode: rust().language, selectors: ["rust", "rs"] },
  { mode: sass({ indented: false }).language, selectors: ["scss"] },
  { mode: sql().language, selectors: ["sql"] },
  { mode: vue().language, selectors: ["vue"] },
  { mode: wast().language, selectors: ["wast"] },
  { mode: xml().language, selectors: ["xml"] },
  { mode: yaml().language, selectors: ["yaml", "yml"] },
  { mode: hcl().language, selectors: ["hcl", "terraform"] },
  { mode: tikzLanguage, selectors: ["tikz"] },
  { mode: tikzCdLanguage, selectors: ["tikzcd"] },
  {
    // Hear me out: There may be no mermaid syntax highlighting, BUT we need it
    // to be inside a 'FencedCode' Syntax node so that our renderer can pick it
    // up. By defining an empty StreamParser, we can ensure that there will be
    // such a structure, even if it's basically just plain text.
    mode: StreamLanguage.define({
      token(stream, _state) {
        stream.skipToEnd();
        return null;
      },
    }),
    selectors: ["mermaid"],
  },
  { mode: StreamLanguage.define(c), selectors: ["c"] },
  { mode: StreamLanguage.define(clojure), selectors: ["clojure"] },
  { mode: StreamLanguage.define(cobol), selectors: ["cobol"] },
  { mode: StreamLanguage.define(commonLisp), selectors: ["clisp", "commonlisp"] },
  { mode: StreamLanguage.define(csharp), selectors: ["c#", "csharp", "cs"] },
  { mode: StreamLanguage.define(dart), selectors: ["dart", "dt"] },
  { mode: StreamLanguage.define(diff), selectors: ["diff"] },
  { mode: StreamLanguage.define(dockerFile), selectors: ["docker", "dockerfile"] },
  { mode: elixirLanguage, selectors: ["elixir", "ex", "exs"] },
  { mode: StreamLanguage.define(elm), selectors: ["elm"] },
  { mode: StreamLanguage.define(fortran), selectors: ["fortran"] },
  { mode: StreamLanguage.define(fSharp), selectors: ["f#", "fsharp"] },
  { mode: StreamLanguage.define(haskell), selectors: ["haskell", "hs"] },
  { mode: StreamLanguage.define(julia), selectors: ["julia", "jl"] },
  { mode: StreamLanguage.define(kotlin), selectors: ["kotlin", "kt"] },
  { mode: StreamLanguage.define(lua), selectors: ["lua"] },
  { mode: StreamLanguage.define(objectiveC), selectors: ["objective-c", "objectivec", "objc"] },
  { mode: StreamLanguage.define(octave), selectors: ["octave"] },
  { mode: StreamLanguage.define(pascal), selectors: ["pascal"] },
  { mode: StreamLanguage.define(perl), selectors: ["perl", "pl"] },
  { mode: StreamLanguage.define(powerShell), selectors: ["powershell"] },
  { mode: StreamLanguage.define(r), selectors: ["r"] },
  { mode: StreamLanguage.define(ruby), selectors: ["ruby", "rb"] },
  { mode: StreamLanguage.define(scala), selectors: ["scala"] },
  { mode: StreamLanguage.define(scheme), selectors: ["scheme"] },
  { mode: StreamLanguage.define(shell), selectors: ["shell", "sh", "bash"] },
  { mode: StreamLanguage.define(smalltalk), selectors: ["smalltalk", "st"] },
  { mode: StreamLanguage.define(sparql), selectors: ["sparql"] },
  { mode: StreamLanguage.define(stex), selectors: ["latex", "tex"] },
  { mode: StreamLanguage.define(stexMath), selectors: ["math"] },
  { mode: StreamLanguage.define(swift), selectors: ["swift"] },
  { mode: StreamLanguage.define(tcl), selectors: ["tcl"] },
  { mode: StreamLanguage.define(toml), selectors: ["toml", "ini"] },
  { mode: StreamLanguage.define(turtle), selectors: ["turtle", "ttl"] },
  { mode: StreamLanguage.define(vb), selectors: ["vb.net", "vb", "visualbasic"] },
  { mode: StreamLanguage.define(verilog), selectors: ["verilog", "v", "systemverilog"] },
  { mode: StreamLanguage.define(vhdl), selectors: ["vhdl", "vhd"] },
];

// Add code folding to custom nodes
const customFoldNodeProp = foldNodeProp.add((type) => {
  if (type.is("PandocDiv") || type.is("YAMLFrontmatter")) {
    return (node, state) => ({ from: state.doc.lineAt(node.from).to, to: node.to });
  }

  return undefined;
});

// Pandoc syntax nodes are defined by the vendored @lezer/markdown fork. The
// application only assigns editor-theme tags to those existing node types; it
// does not redefine their recognition rules here.
const pandocStyleProps = styleTags({
  "YAMLFrontmatter/...": customTags.YAMLFrontmatter,
  YAMLFrontmatterStart: customTags.YAMLFrontmatterStart,
  YAMLFrontmatterEnd: customTags.YAMLFrontmatterEnd,
  "Citation/...": customTags.Citation,
  CitationMark: customTags.CitationMark,
  CitationPrefix: customTags.CitationPrefix,
  CitationSuppressAuthorFlag: customTags.CitationSuppressAuthorFlag,
  CitationAtSign: customTags.CitationAtSign,
  CitationCitekey: customTags.CitationCitekey,
  CitationLocator: customTags.CitationLocator,
  CitationSuffix: customTags.CitationSuffix,
  "Footnote/...": customTags.Footnote,
  "FootnoteRef/...": customTags.FootnoteRef,
  FootnoteRefLabel: customTags.FootnoteRefLabel,
  "ZknLink/...": customTags.ZknLink,
  ZknLinkMark: customTags.ZknLinkMark,
  ZknLinkContent: customTags.ZknLinkContent,
  ZknLinkTitle: customTags.ZknLinkTitle,
  ZknLinkPipe: customTags.ZknLinkPipe,
  PandocAttribute: customTags.PandocAttribute,
  PandocAttributeMark: customTags.PandocAttributeMark,
  "PandocDiv/...": customTags.PandocDiv,
  PandocDivInfo: customTags.PandocDivInfo,
  PandocDivMark: customTags.PandocDivMark,
  "PandocSpan/...": customTags.PandocSpan,
  PandocSpanMark: customTags.PandocSpanMark,
  "Table/...": customTags.Table,
  TableHeader: customTags.TableHeader,
  TableDelimiter: customTags.TableDelimiter,
  TableRow: customTags.TableRow,
  TableCell: customTags.TableCell,
});

export interface MarkdownParserConfig {
  zknLinkParserConfig?: ZknLinkParserConfig;
}

// TIP: Uncomment the following line to get a full list of all unique characters
// that are capable of belonging to a selector
// console.log([...new Set(codeLanguages.map(x => x.selectors).flat().join('').split(''))])

// This file returns a syntax extension that provides parsing and syntax
// capabilities
export default function markdownParser(config?: MarkdownParserConfig): LanguageSupport {
  return markdown({
    // Start from CommonMark rather than CodeMirror's GFM convenience parser.
    // The vendored fork adds the Pandoc dialect explicitly; carrying GFM's
    // table/autolink/emoji grammar underneath it would make the tree accept
    // syntax that Pandoc's `markdown` reader does not.
    base: commonmarkLanguage,
    codeLanguages: (infoString) => {
      // infostrings must start with the language and can be surrounded by curly
      // brackets. We just extract everything from the beginning that is an
      // allowed selector-part
      const match = /^{?([a-z.#+-]+)/.exec(infoString.toLowerCase());
      if (match === null) {
        return null;
      }

      // Additional check: For simple info strings, we need to use the entire
      // match, but if the user has opted for a fenced code attribute, we need
      // to account for the dot in the beginning.
      const infoLang = match[1].startsWith(".") ? match[1].slice(1) : match[1];

      // Return an adequate language
      for (const entry of codeLanguages) {
        if (entry.selectors.includes(infoLang)) {
          return entry.mode;
        }
      }

      return null;
    },
    addKeymap: false,
    extensions: [
      Pandoc({
        wikilinks: config?.zknLinkParserConfig?.format,
      }),
      {
        props: [customFoldNodeProp, pandocStyleProps],
        wrap: (inner, input, fragments, ranges) =>
          yamlCodeParse()(
            mathCodeParse()(
              rawLatexLanguageParse()(inner, input, fragments, ranges),
              input,
              fragments,
              ranges,
            ),
            input,
            fragments,
            ranges,
          ),
        // These are application syntax, not Pandoc Markdown. They intentionally
        // remain as thin extensions on top of the fork-owned dialect.
        parseInline: [zknTagParser, highlightParser],
        defineNodes: [
          { name: "HighlightMark", style: customTags.HighlightMark },
          {
            name: "HighlightContent",
            style: { "HighlightContent/...": customTags.HighlightContent },
          },
          { name: "ZknTag", style: { "ZknTag/...": customTags.ZknTag } },
          { name: "ZknTagMark", style: customTags.ZknTagMark },
        ],
      },
    ],
  });
}
