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
import { parsePandocAttributes } from 'source/common/pandoc-util/parse-pandoc-attributes'
import { divModelFromNode, type PandocDivModel } from 'source/common/pandoc-util/pandoc-div-model'
import { rangeInPreviewSuppression, reviewSuppressionChanged } from '../util/range-in-preview-suppression'
import { configField } from '../util/configuration'
import { VISUAL_INDENT_EXEMPT_CLASS } from '../plugins/visual-indent'

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
          const model = divModelFromNode(view.state.doc, node.node)
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
function revealDivSource (target: EventTarget|null, view: EditorView): boolean {
  if (!(target instanceof Element)) {
    return false
  }

  const label = target.closest('pandoc-div-open-wrapper[data-pandoc-div-state="inactive"]')
  const from = label?.getAttribute('data-pandoc-div-from')
  if (from === null || from === undefined) {
    return false
  }

  view.dispatch({ selection: { anchor: Number(from) }, scrollIntoView: true })
  view.focus()
  return true
}

const pandocDivSpanPlugin = ViewPlugin.fromClass(class {
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
    if (update.docChanged || update.viewportChanged || update.selectionSet ||
        reviewSuppressionChanged(update) ||
        syntaxTree(update.state) !== syntaxTree(update.startState)) {
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
      if (!revealDivSource(event.target, view)) {
        return false
      }

      event.preventDefault()
      return true
    },
    keydown: (event, view) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return false
      }

      if (!revealDivSource(event.target, view)) {
        return false
      }

      event.preventDefault()
      return true
    },
  },
})

// Accent variables per semantic family, applied identically to the content
// wrapper and the open-fence wrapper. Kept as one generated map so the family
// list cannot drift between element types.
const SEMANTIC_FAMILY_ACCENTS = Object.fromEntries(
  [ 'result', 'definition', 'explanation', 'task', 'warning', 'proof' ].map(family => [
    `pandoc-div-wrapper.pandoc-div--${family}, pandoc-div-open-wrapper.pandoc-div--${family}`,
    { '--pandoc-div-accent': `var(--zettlr-editor-pandoc-div-${family})` },
  ])
)

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
    ...SEMANTIC_FAMILY_ACCENTS,
    'pandoc-div-wrapper.pandoc-div--proof': {
      borderLeftStyle: 'dotted',
    },
    // The visual-indent line decorations are reverted through the
    // VISUAL_INDENT_EXEMPT_CLASS contract owned by the visual-indent plugin.
    'pandoc-div-wrapper .cm-line, pandoc-div-ancestor-wrapper .cm-line, pandoc-div-active-wrapper .cm-line': {
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
      backgroundColor: 'var(--zettlr-editor-highlight-color)',
    },
    '.underline .cm-pandoc-span': {
      textDecoration: 'underline',
    },
    '.smallcaps .cm-pandoc-span': {
      fontVariantCaps: 'small-caps',
    }
  })
]
