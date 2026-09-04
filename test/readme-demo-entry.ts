/**
 * Mounts the production editor renderers and exposes a scripted step
 * sequence for the README demo GIFs. The capture driver replays the steps
 * one frame at a time (see readme-demo-capture.cjs); each step returns how
 * long the resulting frame should hold in the assembled animation.
 *
 * Scenes (selected via <body data-scene>):
 *   math   — typing inline/display math with live MathJax rendering
 *   amsthm — typing theorem/proof fenced divs with live styled boxes
 *   review — an external review proposition adjudicated chunk by chunk
 */

import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'
import { renderEmphasis } from 'source/common/modules/markdown-editor/renderers/render-emphasis'
import { renderLinks } from 'source/common/modules/markdown-editor/renderers/render-links'
import { renderMath } from 'source/common/modules/markdown-editor/renderers/render-math'
import { renderPandoc } from 'source/common/modules/markdown-editor/renderers/render-pandoc-div-span'
import { defaultLight, editorTheme } from 'source/common/modules/markdown-editor/theme/editor'
import { initializeMathJax } from 'source/common/util/mathtex-to-html'
import { configField } from 'source/common/modules/markdown-editor/util/configuration'
import { reviewChunksExtension, type ReviewChunksConfig } from 'source/common/modules/markdown-editor/plugins/review-chunks'
import type { ReviewSuggestionView } from '@dts/common/review-diff'

declare global {
  interface Window {
    captureReady: Promise<void>
    demoStepCount: number
    /** Runs step i and returns the hold time (seconds) for its frame. */
    runDemoStep: (index: number) => Promise<number>
  }
}

interface Step {
  run: () => void | Promise<void>
  hold: number
}

const TYPE_HOLD = 0.07
const steps: Step[] = []
let view: EditorView

/** One step per character, inserted at the cursor like real typing. */
function typeChars (text: string, hold: number = TYPE_HOLD): void {
  for (const char of text) {
    steps.push({
      hold,
      run: () => { view.dispatch(view.state.replaceSelection(char)) }
    })
  }
}

/** Moves the cursor to the given offset resolver in one step. */
function moveCursor (position: () => number, hold: number): void {
  steps.push({
    hold,
    run: () => {
      view.dispatch({ selection: { anchor: position() }, scrollIntoView: true })
    }
  })
}

function pause (hold: number): void {
  steps.push({ hold, run: () => { /* hold the current frame */ } })
}

/** Offset of `needle` in the current document (throws when absent). */
function docIndex (needle: string, shift: number = 0): number {
  const index = view.state.doc.toString().indexOf(needle)
  if (index === -1) {
    throw new Error(`demo script lost its landmark: ${needle}`)
  }
  return index + shift
}

const editorExtensions = [
  markdownParser(),
  configField,
  EditorView.lineWrapping,
  editorTheme,
  defaultLight,
  renderPandoc,
  renderEmphasis,
  renderLinks,
  renderMath
]

function mountEditor (doc: string): void {
  const host = document.querySelector<HTMLElement>('#editor')
  if (host === null) {
    throw new Error('Demo capture host is missing')
  }
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: editorExtensions
    })
  })
  view.focus()
}

function scriptMathScene (): void {
  mountEditor('# MathJax with your own macros\n\n')
  pause(0.8)
  typeChars('Let $\\RR$ be the reals; the macro comes from your config file.')
  pause(1.4)
  typeChars('\n\nDisplay math renders the moment the cursor leaves it:\n\n')
  typeChars('\\[\n\\int_{\\RR} e^{-\\pi x^2} \\, dx = 1\n\\]')
  pause(0.9)
  typeChars('\n\nDone.')
  pause(1.8)
  moveCursor(() => docIndex('\\pi x^2'), 1.4)
  steps.push({
    hold: 0.9,
    run: () => {
      const from = docIndex('\\pi ')
      view.dispatch({ changes: { from, to: from + 4 }, selection: { anchor: from } })
    }
  })
  steps.push({
    hold: 0.9,
    run: () => {
      const from = docIndex('= 1', 2)
      view.dispatch({ changes: { from, to: from + 1 }, selection: { anchor: from } })
    }
  })
  typeChars('\\sqrt{\\pi}')
  pause(0.7)
  moveCursor(() => view.state.doc.length, 2.4)
}

function scriptAmsthmScene (): void {
  mountEditor('# Theorem environments\n\n')
  pause(0.8)
  typeChars('::: theorem\nEvery continuous function on a compact interval attains its maximum.\n:::\n', 0.05)
  typeChars('\nProofs get a progressively lighter box:\n\n', 0.05)
  typeChars('::: proof\nCover the interval, extract a finite subcover, compare endpoints.\n:::\n', 0.05)
  typeChars('\nThe boxes stay plain Pandoc markdown.', 0.05)
  pause(2.0)
  moveCursor(() => docIndex('attains'), 1.6)
  moveCursor(() => view.state.doc.length, 2.4)
}

function scriptGalleryScene (): void {
  mountEditor([
    '# Theorem environments',
    '',
    '::: theorem',
    'Every compact interval has a maximum.',
    ':::',
    '',
    '::: definition',
    'A *proper map* preserves compact inverse images, with $\\RR$ as a familiar setting.',
    ':::',
    '',
    '::: remark',
    'The hypothesis matters at the boundary.',
    ':::',
    '',
    '::: problem',
    'Find a counterexample when compactness is removed.',
    ':::',
    '',
    '::: warning',
    'Do not silently replace local compactness by compactness.',
    ':::',
    '',
    '::: proof',
    'Apply the finite-subcover argument.',
    ':::',
    ''
  ].join('\n'))
  pause(0.5)
}

const reviewBaseline = [
  '# Section 3: the main estimate',
  '',
  'The constant in the main inequality is at most 4.',
  '',
  'A long unchanged paragraph separates the two edits so each chunk stands alone.',
  '',
  'The proof of the corollary is left to the reader.',
  ''
].join('\n')

const reviewProposed = reviewBaseline
  .replace('is at most 4', 'is at most 2, by the symmetrization argument')
  .replace('is left to the reader', 'follows from Lemma 3.2 applied to the boundary case')

function scriptReviewScene (): void {
  const host = document.querySelector<HTMLElement>('#editor')
  if (host === null) {
    throw new Error('Demo capture host is missing')
  }

  const compartment = new Compartment()
  const firstStart = reviewProposed.indexOf('is at most 2, by the symmetrization argument')
  const secondStart = reviewProposed.indexOf('follows from Lemma 3.2 applied to the boundary case')
  let suggestions: ReviewSuggestionView[] = [
    {
      suggestionId: 'suggestion-constant',
      removedText: 'is at most 4',
      anchors: [{ from: firstStart, to: firstStart + 'is at most 2, by the symmetrization argument'.length }],
      seam: firstStart,
      description: 'Tighten the constant to 2 via symmetrization.'
    },
    {
      suggestionId: 'suggestion-proof',
      removedText: 'is left to the reader',
      anchors: [{ from: secondStart, to: secondStart + 'follows from Lemma 3.2 applied to the boundary case'.length }],
      seam: secondStart,
      description: 'Replace the reader hand-wave with Lemma 3.2.'
    }
  ]

  const config = (): ReviewChunksConfig => ({ suggestions })

  /**
   * What the provider's broadcast does to this pane when the owner
   * adjudicates a chunk in the annotations panel: the decided suggestion
   * leaves the set, and a rejection puts its removed text back. The editor
   * itself raises nothing — it carries locators only — so the demo drives
   * the decision the way the real broadcast does rather than by clicking a
   * control that no longer exists there.
   */
  const decide = (chunkId: string, decision: 'accept'|'reject'): void => {
    const suggestion = suggestions.find(candidate => candidate.suggestionId === chunkId)
    if (suggestion === undefined) {throw new Error(`demo decision on unknown suggestion ${chunkId}`)}
    suggestions = suggestions.filter(candidate => candidate.suggestionId !== chunkId)
    if (decision === 'accept') {
      view.dispatch({ effects: compartment.reconfigure(reviewChunksExtension(config())) })
    } else {
      const anchor = suggestion.anchors[0]
      view.dispatch({
        changes: anchor === undefined
          ? { from: suggestion.seam, insert: suggestion.removedText }
          : { from: anchor.from, to: anchor.to, insert: suggestion.removedText }
      })
    }
  }

  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: reviewProposed,
      extensions: [
        ...editorExtensions,
        compartment.of(reviewChunksExtension(config()))
      ]
    })
  })
  view.focus()

  pause(2.2)
  steps.push({ hold: 2.0, run: () => { decide('suggestion-constant', 'accept') } })
  pause(2.0) // the accepted chunk's marks leave; the second one still stands
  steps.push({ hold: 2.0, run: () => { decide('suggestion-proof', 'reject') } })
  pause(2.4)
}

async function mount (): Promise<void> {
  await initializeMathJax({
    RR: '\\mathbb{R}',
    abs: ['\\left\\lvert {#1} \\right\\rvert', 1]
  })
  const scene = document.body.dataset.scene ?? 'math'
  if (scene === 'math') {
    scriptMathScene()
  } else if (scene === 'amsthm') {
    scriptAmsthmScene()
  } else if (scene === 'review') {
    scriptReviewScene()
  } else if (scene === 'gallery') {
    scriptGalleryScene()
  } else {
    throw new Error(`Unknown demo scene: ${scene}`)
  }
  await document.fonts.ready
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

window.demoStepCount = 0
window.runDemoStep = async (index: number) => {
  const step = steps[index]
  if (step === undefined) {
    throw new Error(`demo step ${index} does not exist`)
  }
  await step.run()
  return step.hold
}
window.captureReady = mount().then(() => { window.demoStepCount = steps.length })
