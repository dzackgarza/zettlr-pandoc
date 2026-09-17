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

import { StreamLanguage, type StreamParser, type StringStream } from '@codemirror/language'
import type { InlineParser } from '@lezer/markdown'
import { tikzLanguage } from '@tikz-editor/lang-tikz'

interface TikzCdState {
  optionDepth: number
  inMath: boolean
}

const tikzCdParser: StreamParser<TikzCdState> = {
  name: 'tikzcd',
  startState: () => ({ optionDepth: 0, inMath: false }),
  // Make tikzcd a real CodeMirror language surface rather than merely a
  // highlighter. The editor's standard Mod-/ command reads commentTokens from
  // the active nested language, so raw and fenced tikzcd blocks can comment or
  // uncomment one or many selected lines with TeX's '%' line comment marker.
  languageData: {
    commentTokens: { line: '%' }
  },
  token: (stream: StringStream, state: TikzCdState): string|null => {
    if (stream.eatSpace()) return null

    if (stream.match(/^%.*/)) {
      return 'lineComment'
    }

    if (stream.match(/^\\begin\{tikzcd\}/) || stream.match(/^\\end\{tikzcd\}/)) {
      return 'keyword'
    }

    if (stream.match(/^\\(?:arrow|ar)\b/)) {
      return 'keyword'
    }

    if (stream.match(/^\\\\/)) {
      return 'separator'
    }

    if (stream.match(/^\\(?:[A-Za-z@]+|.)/)) {
      return state.inMath ? 'macroName' : 'meta'
    }

    if (stream.match(/^\$\$/) || stream.match(/^\$/)) {
      state.inMath = !state.inMath
      return 'regexp'
    }

    if (stream.match(/^&/)) {
      return 'separator'
    }

    if (stream.match(/^\[/)) {
      state.optionDepth++
      return 'squareBracket'
    }
    if (stream.match(/^\]/)) {
      state.optionDepth = Math.max(0, state.optionDepth - 1)
      return 'squareBracket'
    }

    if (state.optionDepth > 0) {
      if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return 'string'
      if (stream.match(/^'(?![A-Za-z])/)) return 'modifier'
      if (stream.match(/^(?:[rlud]+)(?=\s*(?:,|\]|$))/)) return 'typeName'
      if (stream.match(/^(?:bend\s+(?:left|right)|shift\s+(?:left|right)|crossing\s+over|phantom|swap|near\s+start|near\s+end|description|sloped|dashed|dotted|hook|two\s+heads|tail)(?=\s*(?:=|,|\]|$))/i)) return 'propertyName'
      if (stream.match(/^[A-Za-z][A-Za-z0-9 _.-]*(?=\s*=)/)) return 'propertyName'
      if (stream.match(/^=/)) return 'operator'
      if (stream.match(/^,/)) return 'punctuation'
      if (stream.match(/^-?\d+(?:\.\d+)?/)) return 'number'
      if (stream.match(/^[^,\]=]+/)) return 'variableName'
    }

    if (stream.match(/^-?\d+(?:\.\d+)?/)) return 'number'
    if (stream.match(/^[{}()]/)) return 'bracket'

    stream.next()
    return null
  }
}

export const tikzCdLanguage = StreamLanguage.define(tikzCdParser)
export { tikzLanguage }

const RAW_TIKZ_ENVIRONMENTS = new Map([
  [ 'tikzpicture', tikzLanguage ],
  [ 'tikzcd', tikzCdLanguage ]
] as const)

/**
 * Parses complete raw TikZ environments that Markdown otherwise treats as
 * ordinary paragraph text. The renderer still owns the surrounding Paragraph;
 * this parser contributes only the nested syntax tree used for highlighting.
 */
export const inlineTikzEnvironmentParser: InlineParser = {
  name: 'inlineTikzEnvironment',
  before: 'Escape',
  parse: (ctx, next, pos) => {
    if (next !== 92) return -1 // '\\'

    const relative = pos - ctx.offset
    const lineStart = ctx.text.lastIndexOf('\n', relative - 1) + 1
    if (ctx.text.slice(lineStart, relative).trim() !== '') return -1

    const rest = ctx.slice(pos, ctx.end)
    const open = /^\\begin\{(tikzpicture|tikzcd)\}/.exec(rest)
    if (open === null) return -1

    const environment = open[1] as 'tikzpicture'|'tikzcd'
    const closeToken = `\\end{${environment}}`
    const closeOffset = rest.indexOf(closeToken, open[0].length)
    if (closeOffset === -1) return -1

    const closeTo = pos + closeOffset + closeToken.length
    const source = ctx.slice(pos, closeTo)
    const language = RAW_TIKZ_ENVIRONMENTS.get(environment)
    if (language === undefined) return -1

    const innerTree = ctx.elt(language.parser.parse(source), pos)
    return ctx.addElement(ctx.elt('TikzRaw', pos, closeTo, [innerTree]))
  }
}
