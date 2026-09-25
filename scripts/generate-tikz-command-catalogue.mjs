#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const grammarPath = path.join(
  root,
  'node_modules', '@tikz-editor', 'lezer-tikz', 'src', 'grammar', 'tikz.grammar'
)
const outputPath = path.join(
  root,
  'source', 'common', 'modules', 'markdown-editor', 'autocomplete', 'generated-tikz-commands.ts'
)

const grammar = await readFile(grammarPath, 'utf8')
const commands = new Set()
for (const match of grammar.matchAll(/"\\\\([A-Za-z@]+)/g)) {
  commands.add(`\\${match[1]}`)
}

const sorted = [...commands].sort((a, b) => a.localeCompare(b))
const generated = `/**
 * GENERATED from @tikz-editor/lezer-tikz/src/grammar/tikz.grammar.
 * Run scripts/generate-tikz-command-catalogue.mjs after updating the parser.
 */
export const TIKZ_CONTROL_WORDS = ${JSON.stringify(sorted, null, 2)} as const
`

await writeFile(outputPath, generated, 'utf8')
