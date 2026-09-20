/**
 * CodeMirror YAML-language mounting for YAML metadata nodes emitted by the
 * Pandoc Lezer fork. Markdown recognition lives in @lezer/markdown.
 */

import { yaml } from '@codemirror/lang-yaml'
import { type ParseWrapper, parseMixed } from '@lezer/common'

export function yamlCodeParse (): ParseWrapper {
  const parser = yaml().language.parser
  return parseMixed((node) => {
    if (node.type.name !== 'YAMLFrontmatter') {
      return null
    }
    return { parser, overlay: child => child.type.name === 'CodeText' }
  })
}
