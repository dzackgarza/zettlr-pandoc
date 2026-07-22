/**
 * Syntax displayed by the in-app Pandoc quick reference.
 *
 * Keep cross-reference prefixes here so the editor renderer and the help
 * surface cannot silently drift apart.
 */

export const PANDOC_CITATION_EXAMPLES = [
  { kind: 'parenthetical', syntax: '[@Ols04]' },
  { kind: 'narrative', syntax: '@Ols04 says …' },
  { kind: 'locator', syntax: '[@Ols04, pp. 7-9]' },
  { kind: 'prefix-and-suffix', syntax: '[see @Ols04, Lem. 7.1]' },
  { kind: 'multiple', syntax: '[see @Ols04; @AEGS23]' },
  { kind: 'suppress-author', syntax: 'Smith argues this [-@Smith04].' },
] as const

export const PANDOC_CROSS_REFERENCE_EXAMPLES = [
  {
    kind: 'figure',
    prefix: 'fig',
    label: '![Caption](figure.png){#fig:key}',
    reference: '@fig:key',
  },
  {
    kind: 'table',
    prefix: 'tbl',
    label: ': Caption {#tbl:key}',
    reference: '@tbl:key',
  },
  {
    kind: 'equation',
    prefix: 'eq',
    label: '$$ E = mc^2 $$ {#eq:key}',
    reference: '@eq:key',
  },
  {
    kind: 'section',
    prefix: 'sec',
    label: '## Heading {#sec:key}',
    reference: '@sec:key',
  },
] as const

export const PANDOC_REFERENCE_MODIFIERS = [
  { kind: 'group', syntax: '[@fig:first; @fig:second]' },
  { kind: 'custom-prefix', syntax: '[See @fig:key]' },
  { kind: 'suppress-prefix', syntax: '[-@fig:key]' },
] as const

export const PANDOC_ATTRIBUTE_EXAMPLES = [
  { kind: 'attributes', syntax: '{#identifier .class key="value"}' },
  { kind: 'fenced-div', syntax: '::: {.theorem #main-result}\nContent\n:::' },
  { kind: 'bracketed-span', syntax: '[text]{.class #identifier}' },
] as const

export const PANDOC_CROSSREF_PREFIXES = PANDOC_CROSS_REFERENCE_EXAMPLES.map(example => example.prefix)

export function isSupportedPandocCrossref (id: string): boolean {
  return PANDOC_CROSSREF_PREFIXES.some(prefix => id.startsWith(`${prefix}:`))
}

/**
 * The fixed registry of referenceable theorem-like fenced-div label prefixes,
 * mapping each label prefix (as authored in `{#thm:key}`) to the fenced-div
 * class it labels (as authored in `::: {.theorem #thm:key}` and matched by the
 * export theorem filter). Proof-like divs (`proof`, `sketch`, `solution`) are
 * deliberately absent: they stay unnumbered and unreferenceable.
 */
export const THEOREM_DIV_PREFIXES = {
  thm: 'theorem',
  lem: 'lemma',
  prop: 'proposition',
  cor: 'corollary',
  def: 'definition',
  rmk: 'remark',
  ex: 'example',
  conj: 'conjecture',
  clm: 'claim',
  obs: 'observation',
  qst: 'question',
  prob: 'problem',
  ass: 'assumption',
  warn: 'warning',
  exr: 'exercise',
} as const

export const REFERENCEABLE_DIV_CLASSES = Object.values(THEOREM_DIV_PREFIXES) as readonly string[]

export function isReferenceableDivClass (className: string): boolean {
  return REFERENCEABLE_DIV_CLASSES.includes(className.toLowerCase())
}
