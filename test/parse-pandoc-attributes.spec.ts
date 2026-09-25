/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        parseLinkAttributes tester
 * CVM-Role:        TESTING
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file tests a component of Zettlr.
 *
 * END HEADER
 */

import { deepStrictEqual } from 'assert'
import { ParsedPandocAttributes, parsePandocAttributes } from 'source/common/pandoc-util/parse-pandoc-attributes'

const tests: Array<{ input: string, output: ParsedPandocAttributes|'logs-error' }> = [
  { input: 'width=50%', output: { properties: { width: '50%' } } }, // Attributes without braces
  { input: '{width=50%}', output: { properties: { width: '50%' } } }, // Simple parsing
  { input: ' width = 50% ', output: {} }, // Spaces between = not supported
  { input: '{ width= 50% }', output: {} }, // Spaces between = not supported
  { input: '{ width =50% }', output: {} }, // Spaces between = not supported
  { input: '{width=10}', output: { properties: { width: '10px' } } }, // Parsing width without unit
  { input: '{height=75}', output: { properties: { height: '75px' } } }, // Parsing height without unit
  { input: '{key="some long value"}', output: { properties: { key: 'some long value' } } }, // Parsing quoted values
  { input: '{key="A &amp; B &#x3b1;"}', output: { properties: { key: 'A & B α' } } }, // Pandoc character references in quoted values
  { input: '{key="A \\&amp; B"}', output: { properties: { key: 'A &amp; B' } } }, // Escaped ampersand is literal, not an entity start
  { input: '{key="He said \\"stop\\" twice"}', output: { properties: { key: 'He said "stop" twice' } } }, // Escaped quotes inside quoted values (review C8)
  { input: '{key=some long value}', output: {} }, // Pandoc rejects the malformed list atomically
  {
    // Longer test with all available classes
    input: '#some-id .class1 .class2 width=50% height=25 disabled=false style="font-size: 12px;"',
    output: {
      id: 'some-id',
      classes: ['class1', 'class2'],
      properties: {
        width: '50%',
        height: '25px',
        disabled: 'false',
        style: 'font-size: 12px;'
      }
    }
  },
  // A bare unsupported token invalidates the whole Pandoc attribute list.
  { input: '{#some-id .class1 unsupported-property style="font-size: 12px;"}', output: {} },
  {
    input: '{.theorem\n    title="{\\cite[Thm. 1.1]{AEGS25}}"\n    #thm:intro-main-theorem\n}',
    output: {
      id: 'thm:intro-main-theorem',
      classes: ['theorem'],
      properties: { title: '{\\cite[Thm. 1.1]{AEGS25}}' }
    }
  },
  { input: '{id=explicit class="theorem lemma" -}', output: { id: 'explicit', classes: ['theorem', 'lemma', 'unnumbered'] } }
]

describe('Utility#parsePandocAttributes()', function () {
  for (const test of tests) {
    it(`should parse the attribute string "${test.input}"`, function () {
      deepStrictEqual(parsePandocAttributes(test.input), test.output)
    })
  }
})
