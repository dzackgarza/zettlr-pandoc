/**
 * CodeMirror language mounting for math nodes emitted by the Pandoc Lezer fork.
 *
 * Grammar recognition lives in vendor/lezer-markdown-pandoc and is sourced
 * from Pandoc. This file deliberately contains no Markdown parsing rules; it
 * only overlays the TeX language on the already-recognized math payload.
 */

import { StreamLanguage } from '@codemirror/language'
import { stexMath } from '@codemirror/legacy-modes/mode/stex'
import { type ParseWrapper, parseMixed } from '@lezer/common'

const stexParser = StreamLanguage.define(stexMath).parser

export function mathCodeParse (): ParseWrapper {
  return parseMixed((node, input) => {
    if (node.type.name !== 'InlineCode' && node.type.name !== 'FencedCode') {
      return null
    }
    const mark = node.node.getChild('CodeMark')
    if (mark === null) {
      return null
    }
    const opening = input.read(mark.from, mark.to)
    const isMath = opening === '$' || opening === '$$' || opening === '\\(' || opening === '\\['
    if (!isMath) {
      return null
    }
    return {
      parser: stexParser,
      overlay: child => child.type.name === 'CodeText'
    }
  })
}
