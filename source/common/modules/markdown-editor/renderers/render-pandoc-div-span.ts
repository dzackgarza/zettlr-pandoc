/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        renderPandoc
 * CVM-Role:        View
 * Maintainer:      Bennie Milburn
 * License:         GNU GPL v3
 *
 * Description:     This renderer displays Pandoc spans using
 *                  Decorations and Pandoc Divs using BlockWrappers,
 *                  rendering the attributes defined for the node as
 *                  they would be displayed by pandoc
 *
 * END HEADER
 */

import { syntaxTree } from '@codemirror/language'
import type { EditorSelection, Range, RangeSet } from '@codemirror/state'
import { BlockWrapper, Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { parsePandocAttributes } from 'source/common/pandoc-util/parse-pandoc-attributes'
import { rangeInPreviewSuppression } from '../util/range-in-preview-suppression'
import { configField } from '../util/configuration'

function createSpanDecorations (view: EditorView): RangeSet<Decoration> {
  const ranges: Range<Decoration>[] = []

  const includeAdjacent = view.state.field(configField, false)?.previewModeShowSyntaxWhenCursorIsAdjacent ?? true

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from, to,
      enter: (node) => {
        if (rangeInPreviewSuppression(view.state, node.from, node.to, includeAdjacent)) {
          return
        }

        if (node.name !== 'PandocSpan') {
          return
        }

        const marks = node.node.getChildren('PandocSpanMark')
        const attrs = node.node.getChild('PandocAttribute')

        // Pandoc spans must have an attribute node
        if (!attrs) {
          return
        }

        // Something went wrong
        if (marks.length !== 2) {
          return
        }

        // Only style the text within the marks
        const from = marks[0].to
        const to = marks[1].from

        // Do not apply styling to empty spans
        if (from === to) {
          return
        }

        // Parse the classes and other attributes to render in the decoration.
        const attributes = parsePandocAttributes(view.state.sliceDoc(attrs.from, attrs.to))
        const classes = attributes.classes ?? []
        const id = attributes.id ?? ''

        const deco = Decoration.mark({
          attributes: {
            id,
            class: classes.join(' '),
            ...attributes.properties,
          },
        })

        ranges.push(deco.range(from, to))
      }
    })
  }

  return Decoration.set(ranges, true)
}

type PandocDivState = 'active'|'ancestor'|'inactive'
type PandocDivFamily = 'result'|'definition'|'explanation'|'task'|'warning'|'proof'|'generic'

interface PandocDivModel {
  from: number
  to: number
  openFrom: number
  openTo: number
  contentFrom: number
  contentTo: number
  closeFrom: number
  closeTo: number
  classes: string[]
  id: string
  properties: Record<string, string>
  family: PandocDivFamily
  label: string
  depth: number
}

const semanticClasses: Record<string, PandocDivFamily> = {
  theorem: 'result',
  lemma: 'result',
  proposition: 'result',
  corollary: 'result',
  conjecture: 'result',
  claim: 'result',
  definition: 'definition',
  construction: 'definition',
  notation: 'definition',
  assumption: 'definition',
  example: 'explanation',
  remark: 'explanation',
  observation: 'explanation',
  fact: 'explanation',
  exercise: 'task',
  problem: 'task',
  question: 'task',
  warning: 'warning',
  caution: 'warning',
  danger: 'warning',
  error: 'warning',
  proof: 'proof',
  sketch: 'proof',
  solution: 'proof',
}

function humanizeClassName (className: string): string {
  return className
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase())
}

function classifyDiv (classes: string[]): { family: PandocDivFamily, label: string } {
  for (const authoredClass of classes) {
    const normalizedClass = authoredClass.toLowerCase()
    const family = semanticClasses[normalizedClass]
    if (family !== undefined) {
      return { family, label: humanizeClassName(normalizedClass) }
    }
  }

  return {
    family: 'generic',
    label: classes.length > 0 ? `.${classes[0]}` : 'Div',
  }
}

function safeProperties (properties: Record<string, string>|undefined): Record<string, string> {
  if (properties === undefined) {
    return {}
  }

  return Object.fromEntries(Object.entries(properties).filter(([name]) => {
    return name === 'role' || name === 'title' || name.startsWith('aria-') || name.startsWith('data-')
  }))
}

function divModelFromNode (view: EditorView, node: SyntaxNode): PandocDivModel|undefined {
  const marks = node.getChildren('PandocDivMark')
  const attrs = node.getChild('PandocAttribute')
  const info = node.getChild('PandocDivInfo')

  if ((!attrs && !info) || marks.length !== 2) {
    return undefined
  }

  const openingLine = view.state.doc.lineAt(node.from)
  const closingLine = view.state.doc.lineAt(node.to)
  const contentFrom = Math.min(openingLine.to + 1, closingLine.from)
  const attributes = attrs ? parsePandocAttributes(view.state.sliceDoc(attrs.from, attrs.to)) : {}
  const classes = info ? [view.state.sliceDoc(info.from, info.to)] : []
  if (attributes.classes) {
    classes.push(...attributes.classes)
  }

  const classification = classifyDiv(classes)
  let depth = 0
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (parent.name === 'PandocDiv') {
      depth++
    }
  }
  return {
    from: node.from,
    to: node.to,
    openFrom: openingLine.from,
    openTo: openingLine.to,
    contentFrom,
    contentTo: Math.max(contentFrom, closingLine.from - 1),
    closeFrom: closingLine.from,
    closeTo: closingLine.to,
    classes,
    id: attributes.id ?? '',
    properties: safeProperties(attributes.properties),
    depth,
    ...classification,
  }
}

function collectVisibleDivs (view: EditorView): PandocDivModel[] {
  const divs = new Map<string, PandocDivModel>()

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'PandocDiv') {
          return
        }

        const key = `${node.from}:${node.to}`
        if (!divs.has(key)) {
          const model = divModelFromNode(view, node.node)
          if (model !== undefined) {
            divs.set(key, model)
          }
        }
      },
    })
  }

  return [...divs.values()]
}

function activeDivs (divs: PandocDivModel[], selection: EditorSelection, includeAdjacent: boolean): Set<PandocDivModel> {
  const active = new Set<PandocDivModel>()
  for (const range of selection.ranges) {
    const touched = divs.filter(div => {
      return includeAdjacent
        ? range.to >= div.from && range.from <= div.to
        : range.to > div.from && range.from < div.to
    })
    for (const candidate of touched) {
      const containsDeeperTouchedDiv = touched.some(other => {
        return other !== candidate &&
          candidate.from <= other.from &&
          candidate.to >= other.to &&
          (candidate.from !== other.from || candidate.to !== other.to)
      })
      if (!containsDeeperTouchedDiv) {
        active.add(candidate)
      }
    }
  }
  return active
}

function stateForDiv (div: PandocDivModel, active: Set<PandocDivModel>): PandocDivState {
  if (active.has(div)) {
    return 'active'
  }

  const containsActiveDiv = [...active].some(activeDiv => {
    return div.from <= activeDiv.from && div.to >= activeDiv.to
  })
  return containsActiveDiv ? 'ancestor' : 'inactive'
}

function presentationAttributes (div: PandocDivModel, state: PandocDivState): Record<string, string> {
  return {
    class: [
      'pandoc-div',
      `pandoc-div--${state}`,
      `pandoc-div--${div.family}`,
    ].join(' '),
    'data-pandoc-div-state': state,
    'data-pandoc-div-family': div.family,
    'data-pandoc-div-label': div.label,
    'data-pandoc-div-from': String(div.from),
    'data-pandoc-div-depth': String(Math.min(div.depth, 3)),
  }
}

function contentAttributes (div: PandocDivModel, state: PandocDivState): Record<string, string> {
  return {
    ...presentationAttributes(div, state),
    class: [ presentationAttributes(div, state).class, ...div.classes ].join(' '),
  }
}

function authoredMetadataAttributes (div: PandocDivModel): Record<string, string> {
  const authoredTitle = div.properties.title
  const description = [
    div.id === '' ? undefined : `#${div.id}`,
    ...div.classes.map(className => `.${className}`),
    authoredTitle,
  ].filter(value => value !== undefined).join(' ')

  return {
    ...(div.id === '' ? {} : { 'data-pandoc-authored-id': div.id }),
    ...(description === '' ? {} : { title: description }),
  }
}

function wrapperRank (div: PandocDivModel): number {
  // CodeMirror nests lower-ranked wrappers inside higher-ranked wrappers.
  return Math.max(1, 90 - div.depth)
}

function addFenceWrappers (ranges: Range<BlockWrapper>[], div: PandocDivModel, state: PandocDivState): void {
  const openWrapper = BlockWrapper.create({
    tagName: 'pandoc-div-open-wrapper',
    attributes: {
      ...presentationAttributes(div, state),
      ...authoredMetadataAttributes(div),
      ...(state === 'inactive'
        ? { role: 'button', tabindex: '0', 'aria-label': `Edit ${div.label} fenced div` }
        : {}),
    },
    rank: wrapperRank(div),
  })
  const closeWrapper = BlockWrapper.create({
    tagName: 'pandoc-div-close-wrapper',
    attributes: presentationAttributes(div, state),
    rank: wrapperRank(div),
  })
  ranges.push(openWrapper.range(div.openFrom, div.openTo))
  ranges.push(closeWrapper.range(div.closeFrom, div.closeTo))
}

function createDivDecorations (view: EditorView): RangeSet<BlockWrapper> {
  const ranges: Range<BlockWrapper>[] = []
  const includeAdjacent = view.state.field(configField, false)?.previewModeShowSyntaxWhenCursorIsAdjacent ?? true
  const divs = collectVisibleDivs(view)
  const active = activeDivs(divs, view.state.selection, includeAdjacent)

  for (const div of divs) {
    const state = stateForDiv(div, active)

    if (state === 'active') {
      const wrapper = BlockWrapper.create({
        tagName: 'pandoc-div-active-wrapper',
        attributes: presentationAttributes(div, state),
        rank: wrapperRank(div),
      })
      ranges.push(wrapper.range(div.openFrom, div.closeTo))
      continue
    }

    addFenceWrappers(ranges, div, state)
    if (div.contentFrom < div.contentTo) {
      const wrapper = BlockWrapper.create({
        tagName: state === 'ancestor' ? 'pandoc-div-ancestor-wrapper' : 'pandoc-div-wrapper',
        attributes: contentAttributes(div, state),
        rank: wrapperRank(div),
      })
      ranges.push(wrapper.range(div.contentFrom, div.contentTo))
    }
  }

  return BlockWrapper.set(ranges, true)
}

const pandocDivSpanPlugin = ViewPlugin.fromClass(class {
  spanDecorations: DecorationSet
  divWrappers: RangeSet<BlockWrapper>

  constructor (view: EditorView) {
    this.spanDecorations = createSpanDecorations(view)
    this.divWrappers = createDivDecorations(view)
  }

  update (update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || update.selectionSet) {
      this.spanDecorations = createSpanDecorations(update.view)
      this.divWrappers = createDivDecorations(update.view)
    }
  }

}, {
  decorations: v => v.spanDecorations,
  provide: plugin => EditorView.blockWrappers.of((view) => {
    return view.plugin(plugin)?.divWrappers ?? BlockWrapper.set([])
  }),
  eventHandlers: {
    mousedown: (event, view) => {
      const target = event.target
      if (!(target instanceof Element)) {
        return false
      }

      const label = target.closest('pandoc-div-open-wrapper[data-pandoc-div-state="inactive"]')
      const from = label?.getAttribute('data-pandoc-div-from')
      if (from === null || from === undefined) {
        return false
      }

      event.preventDefault()
      view.dispatch({ selection: { anchor: Number(from) }, scrollIntoView: true })
      view.focus()
      return true
    },
    keydown: (event, view) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return false
      }

      const target = event.target
      if (!(target instanceof Element)) {
        return false
      }

      const label = target.closest('pandoc-div-open-wrapper[data-pandoc-div-state="inactive"]')
      const from = label?.getAttribute('data-pandoc-div-from')
      if (from === null || from === undefined) {
        return false
      }

      event.preventDefault()
      view.dispatch({ selection: { anchor: Number(from) }, scrollIntoView: true })
      view.focus()
      return true
    },
  },
})

export const renderPandoc = [
  pandocDivSpanPlugin,
  EditorView.baseTheme({
    // This must be set to `display: block` so that the
    // attributes are applied correctly. We use `!important`
    // here so that any styling defined by the div does not
    // apply.
    'pandoc-div-wrapper, pandoc-div-ancestor-wrapper, pandoc-div-active-wrapper': {
      display: 'block !important',
      flex: 'initial !important',
      height: 'initial !important',
      width: 'initial !important',
      maxWidth: '100%',
      minWidth: '0',
      boxSizing: 'border-box',
      whiteSpace: 'pre-wrap !important',
      overflowWrap: 'anywhere !important',
    },
    'pandoc-div-wrapper': {
      '--pandoc-div-accent': 'var(--zettlr-editor-pandoc-div-generic)',
      '--pandoc-div-surface': 'color-mix(in srgb, var(--pandoc-div-accent) 7%, transparent)',
      position: 'relative',
      margin: '0',
      padding: '0 0.8em 0 0.9em',
      borderLeft: '3px solid var(--pandoc-div-accent)',
      borderRadius: '0 0.35em 0.35em 0',
      backgroundColor: 'var(--pandoc-div-surface)',
    },
    'pandoc-div-wrapper.pandoc-div--result': {
      '--pandoc-div-accent': 'var(--zettlr-editor-pandoc-div-result)',
    },
    'pandoc-div-wrapper.pandoc-div--definition': {
      '--pandoc-div-accent': 'var(--zettlr-editor-pandoc-div-definition)',
    },
    'pandoc-div-wrapper.pandoc-div--explanation': {
      '--pandoc-div-accent': 'var(--zettlr-editor-pandoc-div-explanation)',
    },
    'pandoc-div-wrapper.pandoc-div--task': {
      '--pandoc-div-accent': 'var(--zettlr-editor-pandoc-div-task)',
    },
    'pandoc-div-wrapper.pandoc-div--warning': {
      '--pandoc-div-accent': 'var(--zettlr-editor-pandoc-div-warning)',
    },
    'pandoc-div-wrapper.pandoc-div--proof': {
      '--pandoc-div-accent': 'var(--zettlr-editor-pandoc-div-proof)',
      borderLeftStyle: 'dotted',
    },
    'pandoc-div-wrapper .cm-line, pandoc-div-ancestor-wrapper .cm-line, pandoc-div-active-wrapper .cm-line': {
      paddingLeft: 'revert !important',
      textIndent: 'revert !important',
      whiteSpace: 'pre-wrap !important',
      overflowWrap: 'anywhere !important',
    },
    'pandoc-div-open-wrapper, pandoc-div-close-wrapper': {
      display: 'block',
    },
    'pandoc-div-open-wrapper[data-pandoc-div-state="inactive"]': {
      position: 'relative',
      cursor: 'text',
      userSelect: 'none',
    },
    'pandoc-div-open-wrapper[data-pandoc-div-state="inactive"] > .cm-line, pandoc-div-close-wrapper[data-pandoc-div-state="inactive"] > .cm-line, pandoc-div-open-wrapper[data-pandoc-div-state="ancestor"] > .cm-line, pandoc-div-close-wrapper[data-pandoc-div-state="ancestor"] > .cm-line': {
      visibility: 'hidden',
    },
    'pandoc-div-open-wrapper[data-pandoc-div-state="inactive"]::before': {
      content: 'attr(data-pandoc-div-label)',
      position: 'absolute',
      inset: '0 auto 0 0',
      display: 'flex',
      alignItems: 'center',
      padding: '0 0.55em',
      boxSizing: 'border-box',
      border: '1px solid color-mix(in srgb, var(--pandoc-div-accent) 35%, transparent)',
      borderRadius: '999px',
      color: 'var(--pandoc-div-accent)',
      backgroundColor: 'color-mix(in srgb, var(--pandoc-div-accent) 8%, transparent)',
      fontSize: '0.72rem',
      fontWeight: '600',
      letterSpacing: '0.035em',
      lineHeight: 'inherit',
      textTransform: 'uppercase',
    },
    'pandoc-div-open-wrapper': { '--pandoc-div-accent': 'var(--zettlr-editor-pandoc-div-generic)' },
    'pandoc-div-open-wrapper.pandoc-div--result': { '--pandoc-div-accent': 'var(--zettlr-editor-pandoc-div-result)' },
    'pandoc-div-open-wrapper.pandoc-div--definition': { '--pandoc-div-accent': 'var(--zettlr-editor-pandoc-div-definition)' },
    'pandoc-div-open-wrapper.pandoc-div--explanation': { '--pandoc-div-accent': 'var(--zettlr-editor-pandoc-div-explanation)' },
    'pandoc-div-open-wrapper.pandoc-div--task': { '--pandoc-div-accent': 'var(--zettlr-editor-pandoc-div-task)' },
    'pandoc-div-open-wrapper.pandoc-div--warning': { '--pandoc-div-accent': 'var(--zettlr-editor-pandoc-div-warning)' },
    'pandoc-div-open-wrapper.pandoc-div--proof': { '--pandoc-div-accent': 'var(--zettlr-editor-pandoc-div-proof)' },
    'pandoc-div-open-wrapper.pandoc-div--generic::before': {
      fontFamily: 'var(--zettlr-editor-code-font)',
      fontWeight: '500',
      letterSpacing: 'normal',
      textTransform: 'none',
    },
    'pandoc-div-open-wrapper[data-pandoc-div-state="inactive"]:focus-visible::before': {
      outline: '2px solid var(--pandoc-div-accent)',
      outlineOffset: '2px',
    },
    'pandoc-div-ancestor-wrapper': {
      marginLeft: '0.25em',
      paddingLeft: '0.7em',
      borderLeft: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
    },
    'pandoc-div-wrapper[data-pandoc-div-depth="1"], pandoc-div-wrapper[data-pandoc-div-depth="2"], pandoc-div-wrapper[data-pandoc-div-depth="3"]': {
      borderLeftWidth: '2px',
      backgroundColor: 'transparent',
    },
    'pandoc-div-open-wrapper[data-pandoc-div-depth="1"]::before, pandoc-div-open-wrapper[data-pandoc-div-depth="2"]::before, pandoc-div-open-wrapper[data-pandoc-div-depth="3"]::before': {
      fontSize: '0.68rem',
      fontWeight: '550',
    },
    'pandoc-div-active-wrapper': {
      margin: '0',
      paddingLeft: '0.65em',
      borderLeft: '2px solid color-mix(in srgb, currentColor 28%, transparent)',
      backgroundColor: 'color-mix(in srgb, currentColor 2.5%, transparent)',
    },
    // The classes `.mark`, `.underline`, and
    // `.smallcaps` are used by pandoc spans
    '.mark .cm-pandoc-span': {
      backgroundColor: '#ffff0080',
    },
    '&dark .mark .cm-pandoc-span': {
      backgroundColor: '#ffff0060',
    },
    '.underline .cm-pandoc-span': {
      textDecoration: 'underline',
    },
    '.smallcaps .cm-pandoc-span': {
      fontVariantCaps: 'small-caps',
    }
  })
]
