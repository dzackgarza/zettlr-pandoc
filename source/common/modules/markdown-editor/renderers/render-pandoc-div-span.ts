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

import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language'
import { StateField, type EditorSelection, type EditorState, type Range, type RangeSet } from '@codemirror/state'
import {
  BlockWrapper,
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import { divModelFromNode, type PandocDivModel } from 'source/common/pandoc-util/pandoc-div-model'
import { parsePandocAttributes } from 'source/common/pandoc-util/parse-pandoc-attributes'
import { reportError } from 'source/common/util/error-reporting'
import { mathJaxToElem } from 'source/common/util/mathtex-to-html'
import { VISUAL_INDENT_EXEMPT_CLASS } from '../plugins/visual-indent'
import { configField } from '../util/configuration'
import { placeCursorFromRenderedPoint, selectRenderedSourceRange } from './reveal-rendered-source'
import {
  rangeInPreviewSuppression,
  reviewSuppressionChanged,
} from '../util/range-in-preview-suppression'
import { visitVisibleSyntaxNodes } from '../util/visible-syntax-nodes'

function createSpanDecorations (view: EditorView): RangeSet<Decoration> {
  const ranges: Range<Decoration>[] = []

  const includeAdjacent = view.state.field(configField).previewModeShowSyntaxWhenCursorIsAdjacent

  visitVisibleSyntaxNodes(view, (node) => {
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
    // An identifier or class list the span does not name is not rendered: an
    // empty `id` is not a valid HTML identifier.
    const attributes = parsePandocAttributes(view.state.sliceDoc(attrs.from, attrs.to))
    const markAttributes: Record<string, string> = { ...attributes.properties }
    if (attributes.id !== undefined) {
      markAttributes.id = attributes.id
    }
    if (attributes.classes !== undefined) {
      markAttributes.class = attributes.classes.join(' ')
    }

    const deco = Decoration.mark({ attributes: markAttributes })

    ranges.push(deco.range(from, to))
  })

  return Decoration.set(ranges, true)
}

type PandocDivState = 'active' | 'ancestor' | 'inactive'

interface InlineTitlePart {
  kind: 'text' | 'math';
  value: string;
}

function isEscapedAt (text: string, index: number): boolean {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) {
    backslashes++
  }
  return backslashes % 2 === 1
}

/** Split the small inline-math subset useful in authored div titles. */
function inlineTitleParts (title: string): InlineTitlePart[] {
  const parts: InlineTitlePart[] = []
  let textStart = 0
  let cursor = 0

  const pushText = (to: number): void => {
    if (to > textStart) {
      parts.push({ kind: 'text', value: title.slice(textStart, to) })
    }
  }

  while (cursor < title.length) {
    let open = ''
    let close = ''
    if (title.startsWith('\\(', cursor) && !isEscapedAt(title, cursor)) {
      open = '\\('
      close = '\\)'
    } else if (title[cursor] === '$' && !isEscapedAt(title, cursor) && title[cursor + 1] !== '$') {
      open = '$'
      close = '$'
    } else {
      cursor++
      continue
    }

    let closing = cursor + open.length
    while (closing < title.length) {
      const matchesClose = title.startsWith(close, closing) && !isEscapedAt(title, closing)
      if (matchesClose && (close !== '$' || title[closing + 1] !== '$')) {
        break
      }
      closing++
    }
    if (closing >= title.length) {
      cursor += open.length
      continue
    }

    pushText(cursor)
    parts.push({
      kind: 'math',
      value: title.slice(cursor + open.length, closing),
    })
    cursor = closing + close.length
    textStart = cursor
  }

  pushText(title.length)
  return parts
}

function appendRenderedTitle (target: HTMLElement, title: string): void {
  for (const part of inlineTitleParts(title)) {
    if (part.kind === 'text') {
      target.append(document.createTextNode(part.value))
      continue
    }
    const math = document.createElement('span')
    math.classList.add('pandoc-div-header-math')
    mathJaxToElem(part.value, math, 'inline')
    target.append(math)
  }
}

class PandocDivHeaderWidget extends WidgetType {
  constructor (
    readonly label: string,
    readonly title: string | undefined,
  ) {
    super()
  }

  eq (other: PandocDivHeaderWidget): boolean {
    return other.label === this.label && other.title === this.title
  }

  toDOM (): HTMLElement {
    const header = document.createElement('span')
    header.classList.add('pandoc-div-header')

    const label = document.createElement('span')
    label.classList.add('pandoc-div-header-label')
    label.textContent = this.label
    header.append(label)

    if (this.title !== undefined && this.title.trim() !== '') {
      const title = document.createElement('span')
      title.classList.add('pandoc-div-header-title')
      appendRenderedTitle(title, this.title)
      header.append(title)
    }

    return header
  }
}

function collectVisibleDivs (view: EditorView): PandocDivModel[] {
  const divs = new Map<string, PandocDivModel>()

  visitVisibleSyntaxNodes(view, (node) => {
    if (node.name !== 'PandocDiv') {
      return
    }

    const key = `${node.from}:${node.to}`
    if (!divs.has(key)) {
      const model = divModelFromNode(view.state.doc, node.node)
      if (model !== undefined) {
        divs.set(key, model)
      } else if (syntaxTreeAvailable(view.state, view.state.doc.length)) {
        reportError(
          'Pandoc fenced div at ' + String(node.from) + ':' + String(node.to) +
          ' was recognized by the live parser but could not be modeled by the renderer; ' +
          'raw source remains visible.',
        )
      }
    }
  })

  return [...divs.values()]
}

function activeDivs (
  divs: PandocDivModel[],
  selection: EditorSelection,
  includeAdjacent: boolean,
): Set<PandocDivModel> {
  const active = new Set<PandocDivModel>()
  for (const range of selection.ranges) {
    const touched = divs.filter((div) => {
      return includeAdjacent
        ? range.to >= div.from && range.from <= div.to
        : range.to > div.from && range.from < div.to
    })
    for (const candidate of touched) {
      const containsDeeperTouchedDiv = touched.some((other) => {
        return (
          other !== candidate &&
          candidate.from <= other.from &&
          candidate.to >= other.to &&
          (candidate.from !== other.from || candidate.to !== other.to)
        )
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

  const containsActiveDiv = [...active].some((activeDiv) => {
    return div.from <= activeDiv.from && div.to >= activeDiv.to
  })
  return containsActiveDiv ? 'ancestor' : 'inactive'
}

function presentationAttributes (
  div: PandocDivModel,
  state: PandocDivState,
): Record<string, string> {
  return {
    class: [ 'pandoc-div', `pandoc-div--${state}`, `pandoc-div--${div.family}` ].join(' '),
    'data-pandoc-div-state': state,
    'data-pandoc-div-family': div.family,
    'data-pandoc-div-label': div.label,
    'data-pandoc-div-from': String(div.from),
    'data-pandoc-div-depth': String(Math.min(div.depth, 3)),
  }
}

function contentAttributes (div: PandocDivModel, state: PandocDivState): Record<string, string> {
  const presentation = presentationAttributes(div, state)
  return {
    ...presentation,
    class: [ presentation.class, ...div.classes ].join(' '),
  }
}

function authoredMetadataAttributes (div: PandocDivModel): Record<string, string> {
  const authoredTitle = div.properties.title
  const description = [
    div.id === '' ? undefined : `#${div.id}`,
    ...div.classes.map((className) => `.${className}`),
    authoredTitle,
  ]
    .filter((value) => value !== undefined)
    .join(' ')

  return {
    ...(div.id === '' ? {} : { 'data-pandoc-authored-id': div.id }),
    ...(description === '' ? {} : { title: description }),
  }
}

function wrapperRank (div: PandocDivModel): number {
  // CodeMirror nests lower-ranked wrappers inside higher-ranked wrappers.
  return Math.max(1, 90 - div.depth)
}

function addFenceWrappers (
  ranges: Range<BlockWrapper>[],
  div: PandocDivModel,
  state: PandocDivState,
): void {
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

function collectDocumentDivs (state: EditorState): PandocDivModel[] {
  const divs: PandocDivModel[] = []
  syntaxTree(state).iterate({
    enter (node) {
      if (node.name !== 'PandocDiv') {
        return
      }
      const model = divModelFromNode(state.doc, node.node)
      if (model !== undefined) {
        divs.push(model)
      } else if (syntaxTreeAvailable(state, state.doc.length)) {
        reportError(
          'Pandoc fenced div at ' + String(node.from) + ':' + String(node.to) +
          ' was recognized by the live parser but could not be modeled by the renderer; ' +
          'raw source remains visible.',
        )
      }
    },
  })
  return divs
}

function createDivHeaderDecorations (state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const includeAdjacent = state.field(configField).previewModeShowSyntaxWhenCursorIsAdjacent
  const divs = collectDocumentDivs(state)
  const active = activeDivs(divs, state.selection, includeAdjacent)

  for (const div of divs) {
    if (stateForDiv(div, active) !== 'inactive') {
      continue
    }
    ranges.push(
      Decoration.replace({
        widget: new PandocDivHeaderWidget(div.label, div.properties.title),
        block: true,
      }).range(div.openFrom, div.contentFrom),
    )
  }
  return Decoration.set(ranges, true)
}

const pandocDivHeaderField = StateField.define<DecorationSet>({
  create: createDivHeaderDecorations,
  update (value, transaction) {
    const treeChanged = syntaxTree(transaction.state) !== syntaxTree(transaction.startState)
    const selectionChanged = !transaction.startState.selection.eq(transaction.state.selection)
    if (!transaction.docChanged && !selectionChanged && !treeChanged) {
      return value
    }
    return createDivHeaderDecorations(transaction.state)
  },
  provide: (field) => EditorView.decorations.from(field),
})

function createDivDecorations (view: EditorView): RangeSet<BlockWrapper> {
  const ranges: Range<BlockWrapper>[] = []
  const includeAdjacent = view.state.field(configField).previewModeShowSyntaxWhenCursorIsAdjacent
  const divs = collectVisibleDivs(view)
  const active = activeDivs(divs, view.state.selection, includeAdjacent)

  for (const div of divs) {
    const state = stateForDiv(div, active)

    if (state === 'active') {
      const attributes = presentationAttributes(div, state)
      attributes.class = `${attributes.class} ${VISUAL_INDENT_EXEMPT_CLASS}`
      const wrapper = BlockWrapper.create({
        tagName: 'pandoc-div-active-wrapper',
        attributes,
        rank: wrapperRank(div),
      })
      ranges.push(wrapper.range(div.openFrom, div.closeTo))
      continue
    }

    addFenceWrappers(ranges, div, state)
    if (div.contentFrom < div.contentTo) {
      const attributes = contentAttributes(div, state)
      attributes.class = `${attributes.class} ${VISUAL_INDENT_EXEMPT_CLASS}`
      const wrapper = BlockWrapper.create({
        tagName: state === 'ancestor' ? 'pandoc-div-ancestor-wrapper' : 'pandoc-div-wrapper',
        attributes,
        rank: wrapperRank(div),
      })
      ranges.push(wrapper.range(div.contentFrom, div.contentTo))
    }
  }

  return BlockWrapper.set(ranges, true)
}

/**
 * Handles activating an inactive div's source from its rendered open-fence
 * label. Shared by the mousedown and keydown plugin event handlers.
 */
function revealDivSource (event: MouseEvent | KeyboardEvent, view: EditorView): boolean {
  const { target } = event
  if (!(target instanceof Element)) {
    return false
  }

  const label = target.closest('pandoc-div-open-wrapper[data-pandoc-div-state="inactive"]')
  const from = label?.getAttribute('data-pandoc-div-from')
  if (from !== null && from !== undefined) {
    const anchor = Number(from)
    if (event instanceof MouseEvent) {
      return selectRenderedSourceRange(view, event, anchor, anchor)
    }
    event.preventDefault()
    event.stopPropagation()
    view.dispatch({ selection: { anchor }, scrollIntoView: true })
    view.focus()
    return true
  }

  if (!(event instanceof MouseEvent)) {
    return false
  }

  // Replacement widgets (math, citations, images, diagrams...) own their
  // activation and exact source range. Do not turn their click into a generic
  // div-body click.
  if (target.closest('[data-preview-source-from][data-preview-source-to]') !== null) {
    return false
  }

  const panel = target.closest<HTMLElement>('pandoc-div-wrapper[data-pandoc-div-state="inactive"]')
  if (panel === null) {
    return false
  }
  const panelFrom = Number(panel.dataset.pandocDivFrom)
  const panelModel = collectVisibleDivs(view).find(div => div.from === panelFrom)
  if (panelModel === undefined) {
    return false
  }
  return placeCursorFromRenderedPoint(view, event, panelModel.contentFrom, panelModel.contentTo)
}

const pandocDivSpanPlugin = ViewPlugin.fromClass(
  class {
    spanDecorations: DecorationSet
    divWrappers: RangeSet<BlockWrapper>

    constructor (view: EditorView) {
      this.spanDecorations = createSpanDecorations(view)
      this.divWrappers = createDivDecorations(view)
    }

    update (update: ViewUpdate) {
    // The syntax-tree comparison matters when the initial parse misses the
    // synchronous time slice: the parser finishes asynchronously and applies
    // its tree in a transaction that changes neither doc, viewport, nor
    // selection. Without recomputing there, divs that were not yet parsed at
    // construction would stay unwrapped until the next interaction.
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        reviewSuppressionChanged(update) ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      ) {
        this.spanDecorations = createSpanDecorations(update.view)
        this.divWrappers = createDivDecorations(update.view)
      }
    }
  },
  {
    decorations: (v) => v.spanDecorations,
    provide: (plugin) =>
      EditorView.blockWrappers.of((view) => {
        return view.plugin(plugin)?.divWrappers ?? BlockWrapper.set([])
      }),
    eventHandlers: {
      mousedown: (event, view) => {
        if (!revealDivSource(event, view)) {
          return false
        }
        return true
      },
      keydown: (event, view) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
          return false
        }

        if (!revealDivSource(event, view)) {
          return false
        }
        return true
      },
    },
  },
)

// Accent variables per semantic family, applied identically to the content
// wrapper and the open-fence wrapper. Kept as one generated map so the family
// list cannot drift between element types.
const SEMANTIC_FAMILY_ACCENTS = Object.fromEntries(
  [ 'result', 'definition', 'explanation', 'task', 'warning', 'proof', 'float' ].map((family) => [
    `pandoc-div-wrapper.pandoc-div--${family}, pandoc-div-open-wrapper.pandoc-div--${family}`,
    { '--pandoc-div-accent': `var(--zettlr-editor-pandoc-div-${family})` },
  ]),
)

export const renderPandoc = [
  pandocDivHeaderField,
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
    ...SEMANTIC_FAMILY_ACCENTS,
    'pandoc-div-wrapper.pandoc-div--proof': {
      borderLeftStyle: 'dotted',
    },
    // A float holds content rather than prose, so it reads as a container:
    // the same neutral tone as a generic div, with a dashed edge and its own
    // badge (Figure, Table, Listing) to tell the two apart.
    'pandoc-div-wrapper.pandoc-div--float': {
      borderLeftStyle: 'dashed',
    },
    // The visual-indent line decorations are reverted through the
    // VISUAL_INDENT_EXEMPT_CLASS contract owned by the visual-indent plugin.
    'pandoc-div-wrapper .cm-line, pandoc-div-ancestor-wrapper .cm-line, pandoc-div-active-wrapper .cm-line':
      {
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
    'pandoc-div-open-wrapper[data-pandoc-div-state="inactive"] > .cm-line, pandoc-div-close-wrapper[data-pandoc-div-state="inactive"] > .cm-line, pandoc-div-open-wrapper[data-pandoc-div-state="ancestor"] > .cm-line, pandoc-div-close-wrapper[data-pandoc-div-state="ancestor"] > .cm-line':
      {
        visibility: 'hidden',
      },
    '.pandoc-div-header': {
      display: 'flex',
      alignItems: 'center',
      gap: '0.5em',
      width: 'fit-content',
      maxWidth: '100%',
      height: '1.55em',
      pointerEvents: 'none',
      visibility: 'visible',
      whiteSpace: 'nowrap',
    },
    '.pandoc-div-header-label': {
      display: 'inline-flex',
      alignItems: 'center',
      height: '100%',
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
    '.pandoc-div-header-title': {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '0.15em',
      minWidth: '0',
      overflow: 'hidden',
      color: 'inherit',
      fontSize: '0.9em',
      fontWeight: '550',
      lineHeight: '1.2',
      textOverflow: 'ellipsis',
      textTransform: 'none',
    },
    '.pandoc-div-header-math mjx-container': {
      margin: '0 !important',
      fontSize: '1em !important',
    },
    'pandoc-div-open-wrapper': { '--pandoc-div-accent': 'var(--zettlr-editor-pandoc-div-generic)' },
    'pandoc-div-open-wrapper.pandoc-div--generic .pandoc-div-header-label': {
      fontFamily: 'var(--zettlr-editor-code-font)',
      fontWeight: '500',
      letterSpacing: 'normal',
      textTransform: 'none',
    },
    'pandoc-div-open-wrapper[data-pandoc-div-state="inactive"]:focus-visible .pandoc-div-header-label': {
      outline: '2px solid var(--pandoc-div-accent)',
      outlineOffset: '2px',
    },
    'pandoc-div-ancestor-wrapper': {
      marginLeft: '0.25em',
      paddingLeft: '0.7em',
      borderLeft: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
    },
    'pandoc-div-wrapper[data-pandoc-div-depth="1"], pandoc-div-wrapper[data-pandoc-div-depth="2"], pandoc-div-wrapper[data-pandoc-div-depth="3"]':
      {
        borderLeftWidth: '2px',
        backgroundColor: 'transparent',
      },
    'pandoc-div-open-wrapper[data-pandoc-div-depth="1"] .pandoc-div-header-label, pandoc-div-open-wrapper[data-pandoc-div-depth="2"] .pandoc-div-header-label, pandoc-div-open-wrapper[data-pandoc-div-depth="3"] .pandoc-div-header-label':
      {
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
      backgroundColor: 'var(--zettlr-editor-highlight-color)',
    },
    '.underline .cm-pandoc-span': {
      textDecoration: 'underline',
    },
    '.smallcaps .cm-pandoc-span': {
      fontVariantCaps: 'small-caps',
    },
  }),
]
