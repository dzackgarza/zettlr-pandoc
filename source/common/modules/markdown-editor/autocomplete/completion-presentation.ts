/**
 * Presentation metadata for CodeMirror's native completion list.
 *
 * The menu deliberately follows the same three-column model used by this
 * workstation's nvim-cmp configuration: compact kind/source icon, completion
 * abbreviation, and a right-aligned bracketed source name. CodeMirror remains
 * the completion engine and popup owner; these helpers only feed its documented
 * `addToOptions`/`optionClass` presentation hooks.
 */
import type { Completion, CompletionInfo } from '@codemirror/autocomplete'

export type CompletionSourceName =
  'Code'|'Cite'|'Ref'|'File'|'Heading'|'Tag'|'Emoji'|'Snippet'|
  'Pandoc'|'Markdown'|'LaTeX'|'MathJax'|'Macro'|'TikZ'|'tikzcd'|'Prose'|'Dictionary'|'Buffer'

export interface PresentedCompletion extends Completion {
  /** Compact source column analogous to nvim-cmp's `vim_item.menu`. */
  zettlrSource?: CompletionSourceName
}

export interface CompletionInfoSpec {
  title: string
  source?: CompletionSourceName
  description?: string
  syntax?: string
  insertion?: string
  notes?: string[]
}

const SOURCE_ICON: Record<CompletionSourceName, string> = {
  Code: 'code',
  Cite: 'book',
  Ref: 'library',
  File: 'file',
  Heading: 'view-list',
  Tag: 'tag',
  Emoji: 'happy-face',
  Snippet: 'add-text',
  Pandoc: 'code',
  Markdown: 'note',
  LaTeX: 'code-alt',
  MathJax: 'asterisk',
  Macro: 'asterisk',
  TikZ: 'network-globe',
  tikzcd: 'network-globe',
  Prose: 'text',
  Dictionary: 'text',
  Buffer: 'note'
}

const TEXT_SOURCE_ICON: Partial<Record<CompletionSourceName, string>> = {
  LaTeX: 'T',
  MathJax: 'M',
  Macro: 'M',
  Dictionary: 'D',
  Prose: 'D',
  Snippet: 'S',
  Cite: 'C',
  Ref: 'R',
  File: 'F',
  Heading: 'H',
  Tag: '#',
  Buffer: 'B'
}

export function completionSourceOf (completion: Completion): CompletionSourceName|undefined {
  return (completion as PresentedCompletion).zettlrSource
}

/** Compatibility name used by source-level tests and external completion helpers. */
export const completionSource = completionSourceOf

export function completionIconText (completion: Completion): string {
  const source = completionSourceOf(completion)
  if (source !== undefined && TEXT_SOURCE_ICON[source] !== undefined) {
    return TEXT_SOURCE_ICON[source]
  }
  const type = completion.type?.split(/\s+/u)[0]
  if (type === 'function') return 'ƒ'
  if (type === 'keyword') return 'K'
  if (type === 'type') return 'T'
  if (type === 'text') return 't'
  return ''
}

/** Add a source only when the option has not already declared a more precise one. */
export function withCompletionSource (
  completion: Completion,
  source: CompletionSourceName|undefined
): PresentedCompletion {
  const current = completionSourceOf(completion)
  return current !== undefined || source === undefined
    ? completion as PresentedCompletion
    : { ...completion, zettlrSource: source }
}

/**
 * Rich, reusable documentation panel for completion entries. CodeMirror owns
 * the popout lifecycle; providers only supply the semantic content. Keeping one
 * renderer here makes snippets, macros, LaTeX constructs, files, references,
 * and future sources visually consistent without making prose completion noisy.
 */
export function completionInfoPanel (spec: CompletionInfoSpec): HTMLElement {
  const panel = document.createElement('div')
  panel.className = 'zettlr-completion-info'

  const header = document.createElement('div')
  header.className = 'zettlr-completion-info-header'

  const title = document.createElement('strong')
  title.className = 'zettlr-completion-info-title'
  title.textContent = spec.title
  header.appendChild(title)

  if (spec.source !== undefined) {
    const source = document.createElement('span')
    source.className = 'zettlr-completion-info-source'
    source.textContent = spec.source
    header.appendChild(source)
  }
  panel.appendChild(header)

  if (spec.description !== undefined && spec.description.trim() !== '') {
    const description = document.createElement('div')
    description.className = 'zettlr-completion-info-description'
    description.textContent = spec.description
    panel.appendChild(description)
  }

  if (spec.syntax !== undefined && spec.syntax.trim() !== '') {
    const syntax = document.createElement('div')
    syntax.className = 'zettlr-completion-info-syntax'
    syntax.textContent = spec.syntax
    panel.appendChild(syntax)
  }

  if (spec.insertion !== undefined && spec.insertion !== '') {
    const label = document.createElement('div')
    label.className = 'zettlr-completion-info-section-label'
    label.textContent = 'Inserts'
    panel.appendChild(label)

    const code = document.createElement('pre')
    code.className = 'zettlr-completion-info-code'
    code.textContent = spec.insertion
    panel.appendChild(code)
  }

  if (spec.notes !== undefined) {
    for (const note of spec.notes) {
      const row = document.createElement('div')
      row.className = 'zettlr-completion-info-note'
      row.textContent = note
      panel.appendChild(row)
    }
  }

  return panel
}

/**
 * Give ordinary non-prose completions a useful popout even when their provider
 * has no bespoke documentation. Provider-authored `info` always wins.
 */
export function withDefaultCompletionInfo (
  completion: Completion,
  source: CompletionSourceName|undefined,
  insertion?: string
): Completion {
  if (
    completion.info !== undefined ||
    source === undefined ||
    source === 'Prose' ||
    source === 'Buffer'
  ) {
    return completion
  }

  return {
    ...completion,
    info: (): CompletionInfo => completionInfoPanel({
      title: completion.displayLabel ?? completion.label,
      source,
      description: completion.detail,
      insertion: insertion ?? (typeof completion.apply === 'string' ? completion.apply : completion.label)
    })
  }
}

/** Compact Clarity icon column. Clarity is already the application's icon system. */
export function renderCompletionIcon (completion: Completion): Node|null {
  const source = completionSourceOf(completion)
  if (source === undefined) return null

  const wrapper = document.createElement('span')
  wrapper.className = 'zettlr-completion-icon'
  wrapper.setAttribute('aria-hidden', 'true')

  const icon = document.createElement('cds-icon')
  icon.setAttribute('shape', SOURCE_ICON[source])
  icon.setAttribute('size', 'sm')
  wrapper.appendChild(icon)
  return wrapper
}

/** Rightmost nvim-cmp-style `[Source]` column. */
export function renderCompletionSource (completion: Completion): Node|null {
  const source = completionSourceOf(completion)
  if (source === undefined) return null
  const span = document.createElement('span')
  span.className = 'zettlr-completion-source'
  span.textContent = `[${source}]`
  return span
}

export function completionOptionClass (completion: Completion): string {
  const source = completionSourceOf(completion)
  return source === undefined
    ? 'zettlr-completion-option'
    : `zettlr-completion-option zettlr-completion-source-${source.toLowerCase()}`
}

/**
 * Text-only compatibility projection over the same provenance metadata.
 * The production UI uses the richer Clarity-icon renderers above.
 */
export const completionPresentationOptions = [
  {
    position: 20,
    render (completion: Completion): Node {
      const icon = document.createElement('span')
      icon.className = 'cm-completionIcon cm-completionSourceIcon'
      icon.textContent = completionIconText(completion)
      icon.setAttribute('aria-hidden', 'true')
      return icon
    }
  },
  {
    position: 70,
    render (completion: Completion): Node {
      const source = document.createElement('span')
      source.className = 'cm-completionSource'
      const label = completionSourceOf(completion)
      source.textContent = label === undefined ? '' : `[${label}]`
      if (label === undefined) source.setAttribute('aria-hidden', 'true')
      return source
    }
  }
] as const
