/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        renderYamlFrontmatter
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Renders Markdown YAML front matter as an interactive
 *                  Properties panel with its own YAML CodeMirror editor.
 *
 * END HEADER
 */

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { syntaxTree } from '@codemirror/language'
import { yaml } from '@codemirror/lang-yaml'
import { Annotation, EditorState, StateField, type Extension, type Range } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  WidgetType
} from '@codemirror/view'
import YAML from 'yaml'
import { codeSyntaxHighlighter } from '../theme/syntax'
import { configField } from '../util/configuration'
import { rangeInPreviewSuppression } from '../util/range-in-preview-suppression'

// Interaction model adapted from two existing editor implementations rather
// than inventing another front-matter editor:
// - MarkText/Muya PR #4468: a dedicated collapsible Properties block.
// - haivri/obsidian-yaml-properties: the YAML editor owns its pointer/key
//   events and writes only the front-matter source range back to the document.

const YAML_COMMIT_DELAY_MS = 250
const yamlFrontmatterEdit = Annotation.define<boolean>()

interface FrontmatterRange {
  blockFrom: number
  blockTo: number
  contentFrom: number
  contentTo: number
}

interface YamlSummary {
  valid: boolean
  propertyCount: number|null
}

function summarizeYaml (source: string): YamlSummary {
  const document = YAML.parseDocument(source, { prettyErrors: false })
  if (document.errors.length > 0) {
    return { valid: false, propertyCount: null }
  }

  const value: unknown = document.toJS({ maxAliasCount: 100 })
  if (value !== null && !Array.isArray(value) && typeof value === 'object') {
    return { valid: true, propertyCount: Object.keys(value).length }
  }
  return { valid: true, propertyCount: null }
}

function frontmatterRangeAt (state: EditorState, blockFrom: number): FrontmatterRange|null {
  let found: FrontmatterRange|null = null
  syntaxTree(state).iterate({
    enter (node) {
      if (found !== null || node.name !== 'YAMLFrontmatter' || node.from !== blockFrom) {
        return
      }
      const content = node.node.getChild('CodeText')
      if (content === null) {
        return
      }
      found = {
        blockFrom: node.from,
        blockTo: node.to,
        contentFrom: content.from,
        contentTo: content.to
      }
    }
  })
  return found
}

function updateSummaryDom (card: HTMLElement, source: string): void {
  const summary = summarizeYaml(source)
  const count = card.querySelector<HTMLElement>('.yaml-frontmatter-count')
  const status = card.querySelector<HTMLElement>('.yaml-frontmatter-status')
  if (count !== null) {
    count.textContent = summary.propertyCount === null ? 'YAML' : String(summary.propertyCount)
  }
  if (status !== null) {
    status.textContent = summary.valid ? '' : 'Invalid YAML'
    status.hidden = summary.valid
  }
  card.classList.toggle('yaml-frontmatter-invalid', !summary.valid)
}

class YamlFrontmatterWidget extends WidgetType {
  private latestSource: string
  private commitTimer: number|undefined
  private innerView: EditorView|null = null
  private outerView: EditorView|null = null
  private card: HTMLElement|null = null
  private outsidePointerDocument: Document|null = null
  private outsidePointerHandler: ((event: MouseEvent) => void)|null = null

  constructor (
    readonly range: FrontmatterRange,
    readonly source: string
  ) {
    super()
    this.latestSource = source
  }

  eq (other: YamlFrontmatterWidget): boolean {
    // `latestSource` is advanced before this widget commits into the outer
    // editor. The replacement decoration can therefore move/resize without
    // CodeMirror tearing down the focused nested editor on every save.
    return other.range.blockFrom === this.range.blockFrom &&
      other.latestSource === this.latestSource
  }

  private clearCommitTimer (): void {
    if (this.commitTimer !== undefined) {
      window.clearTimeout(this.commitTimer)
      this.commitTimer = undefined
    }
  }

  private currentDraft (): string {
    return this.innerView?.state.doc.toString() ?? this.latestSource
  }

  private commit (): void {
    this.clearCommitTimer()
    const view = this.outerView
    if (view === null) {
      return
    }

    const currentRange = frontmatterRangeAt(view.state, this.range.blockFrom)
    if (currentRange === null) {
      return
    }
    const draft = this.currentDraft()
    const current = view.state.sliceDoc(currentRange.contentFrom, currentRange.contentTo)
    this.latestSource = draft
    if (draft === current) {
      return
    }

    view.dispatch({
      changes: {
        from: currentRange.contentFrom,
        to: currentRange.contentTo,
        insert: draft
      },
      annotations: yamlFrontmatterEdit.of(true)
    })
  }

  private scheduleCommit (): void {
    this.clearCommitTimer()
    this.commitTimer = window.setTimeout(() => this.commit(), YAML_COMMIT_DELAY_MS)
  }

  private nestedEditorExtensions (card: HTMLElement): Extension {
    return [
      yaml(),
      history(),
      codeSyntaxHighlighter(),
      keymap.of([ indentWithTab, ...defaultKeymap, ...historyKeymap ]),
      EditorView.lineWrapping,
      EditorView.updateListener.of(update => {
        if (!update.docChanged) {
          return
        }
        this.latestSource = update.state.doc.toString()
        updateSummaryDom(card, this.latestSource)
        this.scheduleCommit()
      }),
      EditorView.theme({
        '&': {
          width: '100%',
          color: 'inherit',
          backgroundColor: 'transparent',
          fontSize: '0.9em'
        },
        '&.cm-focused': {
          outline: 'none'
        },
        '.cm-scroller': {
          overflowX: 'auto',
          fontFamily: 'var(--zettlr-editor-code-font)'
        },
        '.cm-content': {
          minHeight: '2.2em',
          padding: '0.55em 0.75em',
          caretColor: 'var(--zettlr-editor-primary-color)'
        },
        '.cm-line': {
          padding: '0'
        },
        '.cm-gutters': {
          display: 'none'
        }
      })
    ]
  }

  toDOM (view: EditorView): HTMLElement {
    this.outerView = view

    const card = document.createElement('section')
    this.card = card
    card.classList.add('yaml-frontmatter-card')
    card.setAttribute('aria-label', 'YAML document properties')

    const header = document.createElement('button')
    header.type = 'button'
    header.classList.add('yaml-frontmatter-header')
    header.setAttribute('aria-expanded', 'true')

    const toggle = document.createElement('span')
    toggle.classList.add('yaml-frontmatter-toggle')
    toggle.textContent = '›'
    toggle.setAttribute('aria-hidden', 'true')

    const heading = document.createElement('span')
    heading.classList.add('yaml-frontmatter-heading')
    heading.textContent = 'Properties'

    const count = document.createElement('span')
    count.classList.add('yaml-frontmatter-count')

    const status = document.createElement('span')
    status.classList.add('yaml-frontmatter-status')
    status.hidden = true

    header.append(toggle, heading, count, status)
    card.append(header)

    const body = document.createElement('div')
    body.classList.add('yaml-frontmatter-body')
    const editorHost = document.createElement('div')
    editorHost.classList.add('yaml-frontmatter-editor')
    body.append(editorHost)
    card.append(body)

    const innerState = EditorState.create({
      doc: this.source,
      extensions: this.nestedEditorExtensions(card)
    })
    this.innerView = new EditorView({ state: innerState, parent: editorHost })
    updateSummaryDom(card, this.source)

    header.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      const collapsed = card.classList.toggle('yaml-frontmatter-collapsed')
      header.setAttribute('aria-expanded', String(!collapsed))
      if (collapsed) {
        this.commit()
      } else {
        this.innerView?.requestMeasure()
      }
    })

    card.addEventListener('focusout', event => {
      const next = event.relatedTarget
      if (!(next instanceof Node) || !card.contains(next)) {
        this.commit()
      }
    })

    this.innerView.dom.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        this.commit()
      }
    }, true)

    // CodeMirror may prevent the default outer-editor mousedown before focus
    // moves, so blur/focusout alone is not a reliable commit boundary. Commit
    // in capture phase before the outer editor gets a chance to reinterpret
    // the same pointer gesture. This mirrors obsidian-yaml-properties.
    this.outsidePointerDocument = card.ownerDocument
    this.outsidePointerHandler = event => {
      const target = event.target
      if (target instanceof Node && !card.contains(target)) {
        this.commit()
      }
    }
    this.outsidePointerDocument.addEventListener('mousedown', this.outsidePointerHandler, true)

    return card
  }

  // A nested editor is an independent editing surface. The outer CodeMirror
  // must never reinterpret its pointer, touch, drag, or keyboard events as a
  // request to move the Markdown document selection.
  ignoreEvent (): boolean {
    return true
  }

  destroy (): void {
    this.clearCommitTimer()
    if (this.outsidePointerDocument !== null && this.outsidePointerHandler !== null) {
      this.outsidePointerDocument.removeEventListener('mousedown', this.outsidePointerHandler, true)
    }
    this.innerView?.destroy()
    this.innerView = null
    this.outerView = null
    this.card = null
    this.outsidePointerDocument = null
    this.outsidePointerHandler = null
  }
}

function createFrontmatterDecorations (state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const includeAdjacent = state.field(configField).previewModeShowSyntaxWhenCursorIsAdjacent

  syntaxTree(state).iterate({
    enter (node) {
      if (node.name !== 'YAMLFrontmatter') {
        return
      }
      if (rangeInPreviewSuppression(state, node.from, node.to, includeAdjacent)) {
        return
      }

      const content = node.node.getChild('CodeText')
      if (content === null) {
        return
      }
      const range: FrontmatterRange = {
        blockFrom: node.from,
        blockTo: node.to,
        contentFrom: content.from,
        contentTo: content.to
      }
      ranges.push(Decoration.replace({
        block: true,
        widget: new YamlFrontmatterWidget(range, state.sliceDoc(content.from, content.to))
      }).range(node.from, node.to))
    }
  })

  return Decoration.set(ranges, true)
}

const frontmatterField = StateField.define<DecorationSet>({
  create: createFrontmatterDecorations,
  update (value, transaction) {
    if (transaction.annotation(yamlFrontmatterEdit) === true) {
      // The nested editor owns this transaction. Map the existing block
      // decoration through its front-matter-only change so the focused nested
      // EditorView and its undo history survive the commit intact.
      return value.map(transaction.changes)
    }
    const treeChanged = syntaxTree(transaction.state) !== syntaxTree(transaction.startState)
    const selectionChanged = !transaction.startState.selection.eq(transaction.state.selection)
    if (!transaction.docChanged && !selectionChanged && !treeChanged) {
      return value
    }
    return createFrontmatterDecorations(transaction.state)
  },
  provide: field => EditorView.decorations.from(field)
})

export const renderYamlFrontmatter = [
  frontmatterField,
  EditorView.baseTheme({
    '.yaml-frontmatter-card': {
      display: 'block',
      boxSizing: 'border-box',
      width: '100%',
      maxWidth: '100%',
      margin: '0.65em 0 1em',
      overflow: 'hidden',
      color: 'inherit',
      backgroundColor: 'color-mix(in srgb, currentColor 2.5%, transparent)',
      border: '1px solid color-mix(in srgb, currentColor 16%, transparent)',
      borderRadius: '0.35em'
    },
    '.yaml-frontmatter-header': {
      display: 'flex',
      alignItems: 'center',
      gap: '0.45em',
      width: '100%',
      padding: '0.42em 0.7em',
      boxSizing: 'border-box',
      color: 'var(--zettlr-editor-secondary-color)',
      backgroundColor: 'color-mix(in srgb, currentColor 2.5%, transparent)',
      border: '0',
      borderBottom: '1px solid color-mix(in srgb, currentColor 13%, transparent)',
      font: 'inherit',
      textAlign: 'left',
      cursor: 'pointer'
    },
    '.yaml-frontmatter-header:focus-visible': {
      outline: '2px solid var(--zettlr-editor-primary-color)',
      outlineOffset: '-2px'
    },
    '.yaml-frontmatter-toggle': {
      display: 'inline-block',
      fontSize: '0.72rem',
      transform: 'rotate(90deg)',
      transition: 'transform 120ms ease'
    },
    '.yaml-frontmatter-collapsed .yaml-frontmatter-toggle': {
      transform: 'rotate(0deg)'
    },
    '.yaml-frontmatter-heading': {
      fontSize: '0.72rem',
      fontWeight: '650',
      letterSpacing: '0.04em',
      textTransform: 'uppercase'
    },
    '.yaml-frontmatter-count': {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: '1.35em',
      height: '1.35em',
      padding: '0 0.34em',
      boxSizing: 'border-box',
      fontSize: '0.68rem',
      border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
      borderRadius: '999px'
    },
    '.yaml-frontmatter-status': {
      marginLeft: 'auto',
      fontSize: '0.72rem',
      color: 'var(--zettlr-editor-error-color)'
    },
    '.yaml-frontmatter-body': {
      display: 'block',
      minWidth: '0'
    },
    '.yaml-frontmatter-collapsed .yaml-frontmatter-body': {
      display: 'none'
    },
    '.yaml-frontmatter-editor': {
      minWidth: '0',
      overflow: 'hidden'
    },
    '.yaml-frontmatter-editor > .cm-editor': {
      minWidth: '0'
    },
    '.yaml-frontmatter-invalid': {
      borderColor: 'color-mix(in srgb, var(--zettlr-editor-error-color) 45%, transparent)'
    },
    '@media (prefers-reduced-motion: reduce)': {
      '.yaml-frontmatter-toggle': {
        transition: 'none'
      }
    }
  })
]
