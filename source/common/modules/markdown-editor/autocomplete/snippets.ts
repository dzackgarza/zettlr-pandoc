/**
 * Portable VS Code snippets hosted by CodeMirror's native snippet runtime.
 *
 * The persisted syntax is VS Code/TextMate. Monaco's parser owns that syntax;
 * this module only adapts the subset CodeMirror can execute into its native
 * snippet template grammar. Active fields, mirroring, Tab/Shift-Tab/Escape,
 * indentation, and snippet lifetime are all owned by @codemirror/autocomplete.
 */
import { reportError } from '@common/util/error-reporting'
import { snippet as codeMirrorSnippet, type Completion } from '@codemirror/autocomplete'
import { StateEffect, StateField, type EditorState } from '@codemirror/state'
import picomatch from 'picomatch'
import {
  Choice,
  Marker,
  Placeholder,
  SnippetParser,
  Text,
  Variable,
  type VariableResolver,
} from 'monaco-editor-core/esm/vs/editor/contrib/snippet/browser/snippetParser.js'
import type { UserSnippet } from '@dts/common/snippets'
import { pathBasename, pathDirname, pathExtname } from '@common/util/renderer-path-polyfill'
import { configField } from '../util/configuration'
import { isMathPosition } from '../util/is-math-position'
import { tikzBlockAt } from '../tikz-block'
import type { AutocompletePlugin } from '.'
import {
  completionInfoPanel,
  type CompletionSourceName,
  type PresentedCompletion,
} from './completion-presentation'

const STANDARD_VARIABLE_NAMES = new Set([
  'CURRENT_YEAR', 'CURRENT_YEAR_SHORT', 'CURRENT_MONTH', 'CURRENT_DATE',
  'CURRENT_HOUR', 'CURRENT_MINUTE', 'CURRENT_SECOND', 'CURRENT_MILLISECOND',
  'CURRENT_DAY_NAME', 'CURRENT_DAY_NAME_SHORT', 'CURRENT_MONTH_NAME',
  'CURRENT_MONTH_NAME_SHORT', 'CURRENT_SECONDS_UNIX', 'CURRENT_MILLISECONDS_UNIX',
  'CURRENT_TIMEZONE_OFFSET', 'CURRENT_TIMEZONE_NAME', 'SELECTION', 'CLIPBOARD',
  'TM_SELECTED_TEXT', 'TM_CURRENT_LINE', 'TM_CURRENT_WORD', 'TM_LINE_INDEX',
  'TM_LINE_NUMBER', 'TM_FILENAME', 'TM_FILENAME_BASE', 'TM_DIRECTORY',
  'TM_DIRECTORY_BASE', 'TM_FILEPATH', 'CURSOR_INDEX', 'CURSOR_NUMBER',
  'RELATIVE_FILEPATH', 'BLOCK_COMMENT_START', 'BLOCK_COMMENT_END', 'LINE_COMMENT',
  'WORKSPACE_NAME', 'WORKSPACE_FOLDER', 'RANDOM', 'RANDOM_HEX', 'UUID'
])

export const snippetsUpdate = StateEffect.define<UserSnippet[]>()

export const snippetsUpdateField = StateField.define<UserSnippet[]>({
  create: () => [],
  update (value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(snippetsUpdate)) {
        return effect.value
      }
    }
    return value
  }
})

function currentWord (state: EditorState): string {
  const range = state.wordAt(state.selection.main.head)
  return range === null ? '' : state.sliceDoc(range.from, range.to)
}

/** Editor-specific variables not supplied by Microsoft's context-free resolvers. */
class EditorVariableResolver implements VariableResolver {
  constructor (private readonly state: EditorState) {}

  resolve (variable: Variable): string | undefined {
    const now = new Date()
    const selection = this.state.selection.main
    const line = this.state.doc.lineAt(selection.head)
    const filePath = this.state.field(configField).metadata.path
    const filename = pathBasename(filePath)
    const ext = pathExtname(filename)

    switch (variable.name) {
      case 'SELECTION':
      case 'TM_SELECTED_TEXT': return this.state.sliceDoc(selection.from, selection.to) || undefined
      case 'TM_CURRENT_LINE': return line.text
      case 'TM_CURRENT_WORD': return currentWord(this.state) || undefined
      case 'TM_LINE_INDEX': return String(line.number - 1)
      case 'TM_LINE_NUMBER': return String(line.number)
      case 'CURSOR_INDEX': return '0'
      case 'CURSOR_NUMBER': return '1'
      case 'TM_FILENAME': return filename
      case 'TM_FILENAME_BASE': return pathBasename(filename, ext)
      case 'TM_DIRECTORY': return pathDirname(filePath)
      case 'TM_DIRECTORY_BASE': return pathBasename(pathDirname(filePath))
      case 'TM_FILEPATH': return filePath
      case 'LINE_COMMENT': return pathExtname(filePath).toLowerCase() === '.tex' ? '%' : undefined
      case 'BLOCK_COMMENT_START': return pathExtname(filePath).toLowerCase() === '.md' ? '<!--' : undefined
      case 'BLOCK_COMMENT_END': return pathExtname(filePath).toLowerCase() === '.md' ? '-->' : undefined
      case 'CURRENT_YEAR': return String(now.getFullYear())
      case 'CURRENT_YEAR_SHORT': return String(now.getFullYear()).slice(-2)
      case 'CURRENT_MONTH': return String(now.getMonth() + 1).padStart(2, '0')
      case 'CURRENT_DATE': return String(now.getDate()).padStart(2, '0')
      case 'CURRENT_HOUR': return String(now.getHours()).padStart(2, '0')
      case 'CURRENT_MINUTE': return String(now.getMinutes()).padStart(2, '0')
      case 'CURRENT_SECOND': return String(now.getSeconds()).padStart(2, '0')
      case 'CURRENT_MILLISECOND': return String(now.getMilliseconds()).padStart(3, '0')
      case 'CURRENT_SECONDS_UNIX': return String(Math.floor(now.getTime() / 1000))
      case 'CURRENT_MILLISECONDS_UNIX': return String(now.getTime())
      case 'CURRENT_TIMEZONE_NAME': return Intl.DateTimeFormat().resolvedOptions().timeZone
      case 'RANDOM': return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')
      case 'RANDOM_HEX': return Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0')
      case 'UUID': return globalThis.crypto?.randomUUID?.()
      default: return undefined
    }
  }
}

function escapeCodeMirrorText (value: string): string {
  // CodeMirror removes these escapes while parsing its snippet template. This
  // keeps arbitrary TeX/Markdown braces literal rather than field syntax.
  return value.replace(/[{}]/g, '\\$&')
}

function containsPlaceholder (marker: Marker): boolean {
  return marker.children.some(child => child instanceof Placeholder || containsPlaceholder(child))
}

function renderMarker (marker: Marker, synthetic: { next: number }): string {
  if (marker instanceof Text) {
    return escapeCodeMirrorText(marker.value)
  }

  if (marker instanceof Placeholder) {
    if (marker.transform !== undefined) {
      throw new Error('placeholder transforms require a richer snippet runtime than CodeMirror provides')
    }
    if (marker.choice instanceof Choice) {
      throw new Error('choice placeholders require a richer snippet runtime than CodeMirror provides')
    }
    if (containsPlaceholder(marker)) {
      throw new Error('nested placeholders require a richer snippet runtime than CodeMirror provides')
    }
    if (marker.children.length === 0) {
      return `\${${marker.index}}`
    }
    const body = marker.children.map(child => renderMarker(child, synthetic)).join('')
    return `\${${marker.index}:${body}}`
  }

  if (marker instanceof Variable) {
    // Microsoft leaves genuinely unknown variables unresolved. VS Code treats
    // those as editable placeholders, whereas a known-but-unset variable is
    // its authored default or empty text.
    if (STANDARD_VARIABLE_NAMES.has(marker.name)) {
      return marker.children.map(child => renderMarker(child, synthetic)).join('')
    }
    const fallback = marker.children.length > 0
      ? marker.children.map(child => renderMarker(child, synthetic)).join('')
      : escapeCodeMirrorText(marker.name)
    return `\${${synthetic.next++}:${fallback}}`
  }

  return marker.children.map(child => renderMarker(child, synthetic)).join('')
}

/** Parse VS Code syntax with Microsoft's parser and adapt it to CodeMirror. */
export function codeMirrorTemplateForSnippet (state: EditorState, body: string): string {
  const parsed = new SnippetParser().parse(body, true, true)
  parsed.resolveVariables(new EditorVariableResolver(state))
  const maxField = parsed.placeholders.reduce((max, placeholder) => Math.max(max, placeholder.index), 0)
  const synthetic = { next: maxField + 1 }
  return parsed.children.map(child => renderMarker(child, synthetic)).join('')
}

function baseLanguageScope (state: EditorState): string {
  const ext = pathExtname(state.field(configField).metadata.path).toLowerCase()
  return ext === '.tex' || ext === '.latex' ? 'latex' : 'markdown'
}

export function snippetScopesAt (state: EditorState, pos: number): Set<string> {
  const base = baseLanguageScope(state)
  const scopes = new Set<string>([base])
  const tikz = base === 'markdown' ? tikzBlockAt(state, pos) : null
  if (base === 'markdown' && (isMathPosition(state, pos) || tikz !== null)) {
    scopes.add('latex')
    scopes.add('tex')
  }
  if (tikz !== null) {
    scopes.add('tikz')
    if (tikz.language === 'tikzcd') {
      scopes.add('tikzcd')
    }
  }
  return scopes
}

function filePatternMatches (pattern: string, filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/')
  const target = pattern.includes('/') ? normalized : pathBasename(normalized)
  return picomatch.isMatch(target, pattern, { dot: true })
}

function applicableSnippets (state: EditorState, pos: number): UserSnippet[] {
  const scopes = snippetScopesAt(state, pos)
  const filePath = state.field(configField).metadata.path
  return (state.field(snippetsUpdateField, false) ?? []).filter(userSnippet => {
    const scopeMatches = userSnippet.scopes.length === 0 || userSnippet.scopes.some(scope => scopes.has(scope))
    const pathIncluded = userSnippet.include.length === 0 || userSnippet.include.some(pattern => filePatternMatches(pattern, filePath))
    const pathExcluded = userSnippet.exclude.some(pattern => filePatternMatches(pattern, filePath))
    return scopeMatches && pathIncluded && !pathExcluded
  })
}

export interface SnippetPresentation {
  source: CompletionSourceName
  detail: string
  notation: string
}

/**
 * Describe the syntax a snippet will actually insert, independently of the
 * fact that it happens to be stored in a VS Code snippet file. This is what a
 * writer needs to distinguish e.g. `lem` -> Pandoc fenced div from a LaTeX
 * lemma environment before accepting the completion.
 */
export function snippetPresentationFor (userSnippet: UserSnippet): SnippetPresentation {
  const body = userSnippet.body
  const description = userSnippet.description?.trim() || userSnippet.name

  const pandocDiv = /(?:^|\n)\s*:::\s*\{([^}\n]*)\}/u.exec(body)
  if (pandocDiv !== null) {
    const divClass = /(?:^|\s)\.([\w:-]+)/u.exec(pandocDiv[1])?.[1]
    const notation = divClass === undefined ? 'Pandoc fenced div' : `Pandoc fenced div .${divClass}`
    return { source: 'Pandoc', detail: `${description} · ${notation.replace('Pandoc ', '')}`, notation }
  }

  if (/(?:^|\n)\s*\[\^[^\]]+\]/u.test(body)) {
    return { source: 'Pandoc', detail: `${description} · footnote`, notation: 'Pandoc footnote' }
  }

  const tikzCd = /\\begin\{tikzcd\}/u.exec(body)
  if (tikzCd !== null) {
    return { source: 'tikzcd', detail: `${description} · tikzcd environment`, notation: 'LaTeX tikzcd environment' }
  }

  const tikz = /\\begin\{tikzpicture\}/u.exec(body)
  if (tikz !== null) {
    return { source: 'TikZ', detail: `${description} · tikzpicture environment`, notation: 'LaTeX TikZ environment' }
  }

  const latexEnvironment = /\\begin\{([^}\n]+)\}/u.exec(body)
  if (latexEnvironment !== null) {
    const environment = latexEnvironment[1]
    return {
      source: 'LaTeX',
      detail: `${description} · \\begin{${environment}}`,
      notation: `LaTeX ${environment} environment`
    }
  }

  if (
    /\\(?:\[|\(|[A-Za-z@]+)/u.test(body) ||
    /\$\$\{\d/u.test(body) ||
    /\$\$[^\n$]+\$\$/u.test(body)
  ) {
    return { source: 'LaTeX', detail: `${description} · LaTeX`, notation: 'LaTeX' }
  }

  if (
    /(?:^|\n)\s*(?:```|~~~)/u.test(body) ||
    /(?:^|\n)\s*\|[^\n]*\|/u.test(body) ||
    /(?:^|\n)\s*\+[-=+]+\+/u.test(body)
  ) {
    return { source: 'Markdown', detail: `${description} · Markdown`, notation: 'Markdown' }
  }

  if (userSnippet.scopes.some(scope => scope === 'latex' || scope === 'tex')) {
    return { source: 'LaTeX', detail: `${description} · LaTeX`, notation: 'LaTeX' }
  }

  return { source: 'Snippet', detail: description, notation: 'snippet' }
}

function completionFor (userSnippet: UserSnippet, prefix: string): Completion {
  const presentation = snippetPresentationFor(userSnippet)
  const completion: PresentedCompletion = {
    label: prefix,
    detail: presentation.detail,
    info: () => completionInfoPanel({
      title: userSnippet.name,
      source: presentation.source,
      description: userSnippet.description,
      syntax: presentation.notation,
      insertion: userSnippet.body,
      notes: userSnippet.scopes.length === 0
        ? undefined
        : [`Scope: ${userSnippet.scopes.join(', ')}`]
    }),
    type: 'text',
    zettlrSource: presentation.source,
    apply (view, picked, from, to) {
      try {
        const template = codeMirrorTemplateForSnippet(view.state, userSnippet.body)
        codeMirrorSnippet(template)(view, picked, from, to)
      } catch (error) {
        reportError(`[Snippets] Could not expand ${userSnippet.name} from ${userSnippet.sourceFile}`, error)
      }
    }
  }
  return completion
}

/**
 * Ordinary snippets are an always-on completion source. CodeMirror owns fuzzy
 * matching/ranking; this source only declares the replacement range and items.
 */
export const snippets: AutocompletePlugin = {
  source: 'Snippet',
  applies (ctx) {
    const match = ctx.matchBefore(/[^\s]+$/)
    if (match === null) {
      return ctx.explicit ? ctx.pos : false
    }
    return match.from
  },
  entries (ctx, _query) {
    return applicableSnippets(ctx.state, ctx.pos).flatMap(userSnippet =>
      userSnippet.prefixes.map(prefix => completionFor(userSnippet, prefix))
    )
  },
  fields: [snippetsUpdateField]
}
