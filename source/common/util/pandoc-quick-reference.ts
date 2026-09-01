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
    displayName: 'Figure',
    label: '![Caption](figure.png){#fig:key}',
    reference: '@fig:key',
  },
  {
    kind: 'table',
    prefix: 'tbl',
    displayName: 'Table',
    label: ': Caption {#tbl:key}',
    reference: '@tbl:key',
  },
  {
    kind: 'equation',
    prefix: 'eq',
    displayName: 'Equation',
    label: '$$ E = mc^2 $$ {#eq:key}',
    reference: '@eq:key',
  },
  {
    kind: 'section',
    prefix: 'sec',
    displayName: 'Section',
    label: '## Heading {#sec:key}',
    reference: '@sec:key',
  },
  {
    kind: 'listing',
    prefix: 'lst',
    displayName: 'Listing',
    label: '```{#lst:key}',
    reference: '@lst:key',
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

/**
 * The crossref label-family authority (review B5): the typed model's
 * CROSSREF_FAMILIES tuple in types/common/references.ts is DERIVED from this
 * list, so the help examples and the reference model cannot drift apart.
 */
export const PANDOC_CROSSREF_PREFIXES = PANDOC_CROSS_REFERENCE_EXAMPLES.map(example => example.prefix)

/**
 * The shared quick-help text filter (issue #1, review A2 / US-06): keeps the
 * entries whose named parts contain the query as a case-insensitive
 * substring. The empty query keeps everything. Each help section supplies
 * its own partsOf projection (titles, details, syntax, examples), so the
 * component never grows a parallel hand-authored matcher.
 *
 * @param   {readonly T[]}                          entries  The section's entries
 * @param   {string}                                query    The typed filter query
 * @param   {(entry: T) => Array<string|undefined>} partsOf  The searchable parts
 *
 * @return  {T[]}                                            The matching entries
 */
export function filterHelpEntries<T> (
  entries: readonly T[],
  query: string,
  partsOf: (entry: T) => Array<string|undefined>
): T[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') {
    return [...entries]
  }

  return entries.filter(entry => {
    return partsOf(entry).some(part => part !== undefined && part.toLowerCase().includes(needle))
  })
}

export function isSupportedPandocCrossref (id: string): boolean {
  return PANDOC_CROSSREF_PREFIXES.some(prefix => id.startsWith(`${prefix}:`) || id.startsWith(`${prefix}-`))
}

/**
 * One referenceable theorem-like family. Identity, fenced-div class, and
 * display name are authored together so no consumer can add a family while
 * omitting the word rendered for it.
 */
export interface TheoremFamilyMetadata {
  prefix: string
  divClass: string
  displayName: string
}

/**
 * The fixed authority for theorem-family identity and presentation.
 * Proof-like divs (`proof`, `sketch`, `solution`) are deliberately absent:
 * they stay unnumbered and unreferenceable.
 */
export const THEOREM_FAMILY_METADATA = [
  { prefix: 'thm', divClass: 'theorem', displayName: 'Theorem' },
  { prefix: 'lem', divClass: 'lemma', displayName: 'Lemma' },
  { prefix: 'prop', divClass: 'proposition', displayName: 'Proposition' },
  { prefix: 'cor', divClass: 'corollary', displayName: 'Corollary' },
  { prefix: 'def', divClass: 'definition', displayName: 'Definition' },
  { prefix: 'rmk', divClass: 'remark', displayName: 'Remark' },
  { prefix: 'ex', divClass: 'example', displayName: 'Example' },
  { prefix: 'conj', divClass: 'conjecture', displayName: 'Conjecture' },
  { prefix: 'clm', divClass: 'claim', displayName: 'Claim' },
  { prefix: 'obs', divClass: 'observation', displayName: 'Observation' },
  { prefix: 'qst', divClass: 'question', displayName: 'Question' },
  { prefix: 'prob', divClass: 'problem', displayName: 'Problem' },
  { prefix: 'ass', divClass: 'assumption', displayName: 'Assumption' },
  { prefix: 'warn', divClass: 'warning', displayName: 'Warning' },
  { prefix: 'exr', divClass: 'exercise', displayName: 'Exercise' },
] as const satisfies readonly TheoremFamilyMetadata[]

export type TheoremFamilyPrefix = typeof THEOREM_FAMILY_METADATA[number]['prefix']

export const REFERENCEABLE_DIV_CLASSES: readonly string[] =
  THEOREM_FAMILY_METADATA.map(metadata => metadata.divClass)

/**
 * Returns the fenced-div class owned by a supported theorem family.
 */
export function theoremDivClass (prefix: TheoremFamilyPrefix): string {
  for (const metadata of THEOREM_FAMILY_METADATA) {
    if (metadata.prefix === prefix) {
      return metadata.divClass
    }
  }

  throw new Error(`Theorem family ${prefix} has no fenced-div metadata`)
}

export function isReferenceableDivClass (className: string): boolean {
  return REFERENCEABLE_DIV_CLASSES.includes(className.toLowerCase())
}

/**
 * One reference-authoring capability documented by the in-app quick help
 * (issue #1 Phase 8, workstream 3): what the editor DOES with authored
 * references, complementing the syntax examples above.
 */
export interface ReferenceAuthoringTopic {
  /** The stable topic identity the help surface keys its rows on */
  kind: string
  /** The short user-facing capability name */
  title: string
  /** The one-line user-facing description */
  detail: string
  /** The affordance that invokes it: a syntax token, shortcut, or gesture */
  syntax: string
}

/**
 * The reference-authoring capabilities the quick help documents.
 *
 * CONTRACT (locked red by test/pandoc-quick-help-references.spec.ts): the
 * editor now SHIPS combined @ completion, hover target previews, Mod-P
 * definition search, Mod-Click navigation with per-pane Back/Forward
 * history, workspace rename, and Project-membership warnings — so the help
 * must document each of them, and the footer claim that cross-reference
 * autocomplete and target previews "are not currently available" (plus the
 * fig/tbl/eq/sec-only convention note) is FALSE and must disappear from
 * PandocQuickHelp.vue.
 *
 */
export const PANDOC_REFERENCE_AUTHORING_TOPICS: readonly ReferenceAuthoringTopic[] = [
  {
    kind: 'completion',
    title: 'Combined completion',
    detail: 'Typing @ completes bibliography citekeys and workspace reference labels together.',
    syntax: '@'
  },
  {
    kind: 'hover-preview',
    title: 'Target previews',
    detail: 'Hovering a reference previews the authored source of its target definition.',
    syntax: 'Hover'
  },
  {
    kind: 'definition-search',
    title: 'Definition search',
    detail: 'Searches every definition in the workspace and jumps to the selected one.',
    syntax: 'Mod-P'
  },
  {
    kind: 'navigation',
    title: 'Follow references',
    detail: 'Jumps to the definition of the clicked reference; Back/Forward restores your previous location.',
    syntax: 'Mod-Click'
  },
  {
    kind: 'rename',
    title: 'Workspace rename',
    detail: 'Editing a definition key offers renaming every use of it across the workspace atomically.',
    syntax: 'Edit #key'
  },
  {
    kind: 'project-warnings',
    title: 'Project warnings',
    detail: 'References whose target lies outside the current Project are flagged before export.',
    syntax: '⚠ Project'
  },
]

/**
 * One fenced-div labeling example pairing a theorem-div label prefix with
 * the exact authored syntax that defines and cites it.
 */
export interface TheoremDivExample {
  /** The authored label prefix */
  prefix: string
  /** The fenced-div class the prefix labels */
  divClass: string
  /** The exact authored definition example */
  label: string
  /** The exact authored reference example */
  reference: string
}

/**
 * The exact fenced-div prefix examples the quick help shows — one per
 * theorem-family metadata entry (all 15; proof-like divs stay absent because
 * they are unreferenceable).
 *
 * CONTRACT (locked red by test/pandoc-quick-help-references.spec.ts): each
 * example is derived from the registry above so the help can never drift
 * from the extractor's supported set: label
 * `::: {.<divClass> #<prefix>:key}` and reference `@<prefix>:key`.
 */
export const THEOREM_DIV_EXAMPLES: readonly TheoremDivExample[] =
  THEOREM_FAMILY_METADATA.map(metadata => ({
    prefix: metadata.prefix,
    divClass: metadata.divClass,
    label: `::: {.${metadata.divClass} #${metadata.prefix}:key}`,
    reference: `@${metadata.prefix}:key`,
  }))
