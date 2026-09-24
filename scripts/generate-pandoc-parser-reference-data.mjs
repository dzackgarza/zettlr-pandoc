import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const PANDOC_VERSION = '3.10.2'
const PANDOC_COMMIT = 'f2ee5dfee866aab007a33552acc6bc01810c6918'
const RAW_ROOT = `https://raw.githubusercontent.com/jgm/pandoc/${PANDOC_COMMIT}/src/Text/Pandoc/Readers`

const SOURCES = {
  latex: {
    url: `${RAW_ROOT}/LaTeX.hs`,
    sha256: '8274bb482ba80eba3408b1a29ea1d3253aa8bea5edb458cafdf728dfcef255e3',
  },
  inline: {
    url: `${RAW_ROOT}/LaTeX/Inline.hs`,
    sha256: '0d9dd3cdf747b5b740872106d023edcf7fcbd1dd13b7c9288f32e2e43985d639',
  },
  citation: {
    url: `${RAW_ROOT}/LaTeX/Citation.hs`,
    sha256: 'c4bb5b0ab8bb1f5a81d9f1f3929befbc20e49dec9bcb82037c168c73050e46b6',
  },
  lang: {
    url: `${RAW_ROOT}/LaTeX/Lang.hs`,
    sha256: '82769ad742cb8d2be36758ef997a5ec93ed85e888bfbf3721a8903c14aac820d',
  },
  siunitx: {
    url: `${RAW_ROOT}/LaTeX/SIunitx.hs`,
    sha256: '3e547ff56e3110cb14e0877104b47814fe0d4fc2f1246aa0b7aa10ae29cb7a94',
  },
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pandocSourceRoot = path.join(repoRoot, 'vendor/lezer-markdown-pandoc/src/pandoc')
const outputPaths = {
  block: path.join(pandocSourceRoot, 'pandoc-block-commands.ts'),
  inline: path.join(pandocSourceRoot, 'pandoc-inline-commands.ts'),
  strategies: path.join(pandocSourceRoot, 'pandoc-inline-command-strategies.ts'),
}

function between (source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`Pinned Pandoc source is missing ${startMarker}`)
  const end = source.indexOf(endMarker, start + startMarker.length)
  if (end < 0) throw new Error(`Pinned Pandoc source is missing ${endMarker}`)
  return source.slice(start + startMarker.length, end)
}

function tupleKeys (source) {
  return new Set(
    [...source.matchAll(/\("([^"]+)"\s*,/gu)].map(match => match[1]),
  )
}

function tupleEntries (source) {
  const entries = []
  let cursor = 0
  for (;;) {
    const match = /\("([^"]+)"\s*,/gu.exec(source.slice(cursor))
    if (match === null) return entries
    const name = match[1]
    const tupleStart = cursor + match.index
    const rhsStart = cursor + match.index + match[0].length
    let depth = 1
    let index = rhsStart
    let inString = false
    let escaped = false
    for (; index < source.length; index++) {
      const char = source[index]
      if (inString) {
        if (escaped) {
          escaped = false
        } else if (char === '\\') {
          escaped = true
        } else if (char === '"') {
          inString = false
        }
        continue
      }
      if (char === '"') {
        inString = true
      } else if (char === '(') {
        depth++
      } else if (char === ')') {
        depth--
        if (depth === 0) break
      }
    }
    if (depth !== 0) {
      throw new Error(`Could not parse Pandoc command tuple for ${name} at ${tupleStart}`)
    }
    entries.push([ name, source.slice(rhsStart, index).trim().replace(/\s+/gu, ' ') ])
    cursor = index + 1
  }
}

function unstarred (name) {
  return name.replace(/\*$/u, '')
}

function blockCommandNames (latex) {
  const blockCommands = between(
    latex,
    'blockCommands = M.fromList',
    '\n\nskipSameFileToks',
  )
  const treatAsBlock = between(
    latex,
    'treatAsBlock = Set.fromList',
    '\n\nisInlineCommand',
  )

  const names = tupleKeys(blockCommands)
  for (const match of treatAsBlock.matchAll(/"([^"]+)"/gu)) {
    names.add(match[1])
  }
  return [...new Set([...names].map(unstarred))].sort()
}

function inlineCommandNames ({ latex, inline, citation, lang, siunitx }) {
  const names = new Set()
  const addTupleRegion = (source, start, end) => {
    for (const name of tupleKeys(between(source, start, end))) {
      names.add(name)
    }
  }

  addTupleRegion(latex, 'rest = M.fromList', '\n\nbracedFilename')
  for (const match of between(
    latex,
    'treatAsInline = Set.fromList',
    '\n\nlookupListDefault',
  ).matchAll(/"([^"]+)"/gu)) {
    names.add(match[1])
  }

  const inlineRegions = [
    [ 'verbCommands = M.fromList', '\n\nmiscCommands' ],
    [ 'miscCommands =', '\n\naccentCommands' ],
    [ 'accentCommands tok =', '\n\ncharCommands' ],
    [ 'charCommands = M.fromList', '\n\nbiblatexInlineCommands' ],
    [ 'biblatexInlineCommands tok = M.fromList', '\n\nnameCommands' ],
    [ 'nameCommands = M.fromList', '\n\nrefCommands' ],
    [ 'refCommands = M.fromList', '\n\nacronymCommands' ],
    [ 'acronymCommands = M.fromList', '\n\ndoAcronym' ],
  ]
  for (const [ start, end ] of inlineRegions) {
    addTupleRegion(inline, start, end)
  }
  addTupleRegion(citation, 'citationCommands inline =', '\n\n-- citations')
  addTupleRegion(siunitx, 'siunitxCommands tok = M.fromList', '\n\ndosi')
  addTupleRegion(lang, 'enquoteCommands tok = M.fromList', '\n\nforeignlanguage')

  names.add('foreignlanguage')
  const polyglossia = between(
    lang,
    'polyglossiaLangToBCP47 = M.fromList',
    '\n\nsimpleLang',
  )
  for (const language of tupleKeys(polyglossia)) {
    names.add('text' + language)
  }

  // raw-latex-syntax classifies TeX control words. Symbol control sequences
  // such as \\%, \\{ or \\, are parsed through a different tokenizer path and
  // must not be added to this word-only lookup.
  return [...new Set(
    [...names]
      .map(unstarred)
      .filter(name => /^[A-Za-z@]+$/u.test(name)),
  )].sort()
}

function inlineCommandStrategies ({ latex, inline, citation, lang, siunitx }) {
  const strategies = new Map()
  const set = (name, strategy) => {
    const current = strategies.get(name)
    if (current !== undefined && current !== strategy) {
      throw new Error(`Conflicting Pandoc inline strategy for ${name}: ${current} vs ${strategy}`)
    }
    strategies.set(name, strategy)
  }
  const setEntries = (source, start, end, classify) => {
    for (const [ name, rhs ] of tupleEntries(between(source, start, end))) {
      if (!/^[A-Za-z@]+\*?$/u.test(name)) continue
      set(name, classify(name, rhs))
    }
  }

  // Literal/translation commands consume no argument tokens.
  setEntries(inline, 'miscCommands =', '\n\naccentCommands', () => 'zero')
  setEntries(inline, 'charCommands = M.fromList', '\n\nbiblatexInlineCommands', () => 'zero')
  setEntries(inline, 'nameCommands = M.fromList', '\n\nrefCommands', () => 'zero')

  // accentWith uses `option mempty tok`; literal accent entries consume none.
  setEntries(inline, 'accentCommands tok =', '\n\ncharCommands', (_name, rhs) => {
    return /\blit\b/u.test(rhs) ? 'zero' : 'optional-tok'
  })

  setEntries(inline, 'refCommands = M.fromList', '\n\nacronymCommands', () => 'raw-command')
  setEntries(inline, 'acronymCommands = M.fromList', '\n\ndoAcronym', () => 'braced')

  setEntries(inline, 'verbCommands = M.fromList', '\n\nmiscCommands', (name) => {
    if (name === 'verb' || name === 'Verb') return 'verbatim'
    if (name === 'lstinline') return 'optional-bracket-verbatim'
    if (name === 'mintinline') return 'skipopts-braced-verbatim'
    throw new Error(`Unknown Pandoc verb command ${name}`)
  })

  setEntries(inline, 'biblatexInlineCommands tok = M.fromList', '\n\nnameCommands', (name, rhs) => {
    if (name === 'RN' || name === 'Rn') return 'roman'
    if (/\bbraced\b/u.test(rhs)) return 'braced'
    if (/\btok\b/u.test(rhs)) return 'tok'
    if (/\bpure\b/u.test(rhs)) return 'zero'
    throw new Error(`Unclassified Pandoc biblatex command ${name}: ${rhs}`)
  })

  setEntries(citation, 'citationCommands inline =', '\n\n-- citations', (name, rhs) => {
    if (name === 'citetext') return 'citation-text'
    if (name === 'citeauthor') return 'citation-author'
    if (name === 'nocite') return 'citation-single'
    return /\bTrue\)?$/u.test(rhs) ? 'citation-multi' : 'citation-single'
  })

  setEntries(siunitx, 'siunitxCommands tok = M.fromList', '\n\ndosi', (name) => {
    const byName = {
      si: 'si-unit',
      unit: 'si-unit',
      SI: 'si-value-unit',
      qty: 'si-value-unit',
      SIrange: 'si-range-unit',
      qtyrange: 'si-range-unit',
      SIlist: 'si-list-unit',
      qtylist: 'si-list-unit',
      numrange: 'si-range',
      numlist: 'skipopts-braced',
      num: 'skipopts-braced',
      ang: 'skipopts-braced',
    }
    const strategy = byName[name]
    if (strategy === undefined) throw new Error(`Unknown Pandoc SIunitx command ${name}`)
    return strategy
  })

  setEntries(lang, 'enquoteCommands tok = M.fromList', '\n\nforeignlanguage', (name) => {
    return name.startsWith('foreignquote') || name.startsWith('hyphenquote')
      ? 'braced-skipopts-tok'
      : 'skipopts-tok'
  })
  set('foreignlanguage', 'braced-tok')
  const polyglossia = between(
    lang,
    'polyglossiaLangToBCP47 = M.fromList',
    '\n\nsimpleLang',
  )
  for (const language of tupleKeys(polyglossia)) set('text' + language, 'optional-rawopt-tok')

  setEntries(latex, 'rest = M.fromList', '\n\nbracedFilename', (name, rhs) => {
    if (name === 'input') return 'rawopts-one-braced'
    if (/\brawInlineOr\b/u.test(rhs)) return 'raw-command'
    if (/\binlines\b/u.test(rhs)) return 'inlines'
    if (name === 'alert') return 'skipopts-tok'
    if (name === 'texorpdfstring') return 'two-tok'
    if (name === 'thanks' || name === 'footnote') return 'skipopts-group'
    if (name === 'footnotemark') return 'optional-numeric-bracket'
    if (name === 'footnotetext') return 'optional-numeric-bracket-group'
    if (name === 'includegraphics' || name === 'includesvg') return 'optional-bracket-braced'
    if (name === 'url' || name === 'nolinkurl' || name === 'ensuremath') return 'braced'
    if (name === 'href') return 'braced-sp-tok'
    if (name === 'hyperlink' || name === 'hypertarget') return 'braced-tok'
    if (name === 'hyperref') return 'hyperref'
    if (name === 'textcolor' || name === 'colorbox') return 'skipopts-braced-tok'
    if (name === 'newtoggle' || name === 'toggletrue' || name === 'togglefalse') return 'braced'
    if (name === 'iftoggle') return 'three-braced-inline'
    if (name === 'ifdim') return 'until-fi'
    if (name === 'today' || name === 'newline') return 'zero'
    if (/\btok\b/u.test(rhs)) return 'tok'
    throw new Error(`Unclassified Pandoc LaTeX.hs inline command ${name}: ${rhs}`)
  })

  // These are not entries in inlineCommands. isInlineCommand nevertheless
  // admits them, and inlineCommand' consequently uses getRawCommand.
  const treatAsInline = between(
    latex,
    'treatAsInline = Set.fromList',
    '\n\nlookupListDefault',
  )
  for (const match of treatAsInline.matchAll(/"([^"]+)"/gu)) {
    if (!strategies.has(match[1])) set(match[1], 'raw-command')
  }

  // Strategy lookup happens after Pandoc's optional-star parse. Preserve exact
  // starred command entries, while ensuring every generated base control word
  // has a fallback strategy.
  const baseNames = inlineCommandNames({ latex, inline, citation, lang, siunitx })
  for (const baseName of baseNames) {
    if (strategies.has(baseName)) continue
    const starred = strategies.get(baseName + '*')
    if (starred !== undefined) {
      strategies.set(baseName, starred)
      continue
    }
    throw new Error(`No Pandoc inline consumption strategy generated for ${baseName}`)
  }
  return strategies
}

function renderSet (exportName, provenance, names) {
  const rows = names.map(name => `  ${JSON.stringify(name)},`).join('\n')
  return `/**
 * GENERATED FILE. Do not hand-edit.
 *
 * Source: Pandoc ${PANDOC_VERSION}, commit ${PANDOC_COMMIT}
 * ${provenance}
 * Generator: scripts/generate-pandoc-parser-reference-data.mjs
 */

export const ${exportName}: ReadonlySet<string> = new Set([
${rows}
])
`
}

function renderStrategies (strategies) {
  const values = [...new Set(strategies.values())].sort()
  const union = values.map(value => JSON.stringify(value)).join(' | ')
  const rows = [...strategies.entries()]
    .sort(([ left ], [ right ]) => left.localeCompare(right))
    .map(([ name, strategy ]) => `  ${JSON.stringify(name)}: ${JSON.stringify(strategy)},`)
    .join('\n')
  return `/**
 * GENERATED FILE. Do not hand-edit.
 *
 * Source: Pandoc ${PANDOC_VERSION}, commit ${PANDOC_COMMIT}
 * Text/Pandoc/Readers/LaTeX.hs inlineCommands and imported parser maps.
 * Generator: scripts/generate-pandoc-parser-reference-data.mjs
 */

export type PandocInlineCommandStrategy = ${union}

export const PANDOC_INLINE_COMMAND_STRATEGIES: Readonly<Record<string, PandocInlineCommandStrategy>> = {
${rows}
}
`
}

async function fetchPinnedSource (label, spec) {
  const response = await fetch(spec.url)
  if (!response.ok) {
    throw new Error(`Could not fetch pinned Pandoc ${label}: HTTP ${response.status}`)
  }
  const source = await response.text()
  const digest = createHash('sha256').update(source).digest('hex')
  if (digest !== spec.sha256) {
    throw new Error(
      `Pinned Pandoc ${label} hash mismatch: expected ${spec.sha256}, got ${digest}`,
    )
  }
  return source
}

const entries = await Promise.all(
  Object.entries(SOURCES).map(async ([ label, spec ]) => [
    label,
    await fetchPinnedSource(label, spec),
  ]),
)
const sources = Object.fromEntries(entries)

const generated = {
  block: renderSet(
    'PANDOC_BLOCK_COMMAND_NAMES',
    'Text/Pandoc/Readers/LaTeX.hs: blockCommands + treatAsBlock.',
    blockCommandNames(sources.latex),
  ),
  inline: renderSet(
    'PANDOC_INLINE_COMMAND_NAMES',
    'Text/Pandoc/Readers/LaTeX.hs inlineCommands and its imported command maps.',
    inlineCommandNames(sources),
  ),
  strategies: renderStrategies(inlineCommandStrategies(sources)),
}

if (process.argv.includes('--check')) {
  for (const kind of Object.keys(generated)) {
    const current = await readFile(outputPaths[kind], 'utf8')
    if (current !== generated[kind]) {
      throw new Error(
        `Generated Pandoc ${kind}-command data is stale. Run ` +
        '`bun run generate:pandoc-reference-data` and commit the result.',
      )
    }
  }
} else {
  await Promise.all(
    Object.keys(generated).map(kind => writeFile(outputPaths[kind], generated[kind])),
  )
}
