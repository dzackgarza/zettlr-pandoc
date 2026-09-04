import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { defaultDark, defaultLight, editorTheme } from 'source/common/modules/markdown-editor/theme/editor'
import {
  setAnnotationSessionEffect,
  textAnnotationsExtension
} from 'source/common/modules/markdown-editor/plugins/text-annotations'
import type { AnnotationSet, TextAnnotation } from 'source/types/common/annotation-domain'

declare global {
  interface Window {
    captureReady: Promise<void>
    annotationsVisualDiagnostics: () => {
      marks: number
      markers: number
      buttons: number
      contentClientWidth: number|undefined
      contentScrollWidth: number|undefined
    }
  }
}

const DOC = [
  '# Theory of Mind',                                                                   // 1
  '',                                                                                    // 2
  '## Introduction',                                                                     // 3
  '',                                                                                    // 4
  'Theory of Mind (ToM) refers to the capacity to attribute mental states to others',    // 5
  'in order to explain and predict behavior.',                                           // 6
  '',                                                                                    // 7
  'It is a cornerstone of human social cognition and underpins empathy and moral',       // 8
  'reasoning throughout adult life.',                                                    // 9
  '',                                                                                    // 10
  '## Development',                                                                      // 11
  '',                                                                                    // 12
  'Classic studies show that children begin to pass false-belief tasks around age four.' // 13
].join('\n')

let idCounter = 0
function annotation (anchor: TextAnnotation['anchor'], state: TextAnnotation['state'] = 'open'): TextAnnotation {
  idCounter += 1
  return {
    annotationId: `annotation-${idCounter}`,
    documentId: 'visual-capture',
    anchor,
    state,
    messages: [{ messageId: `msg-${idCounter}`, author: 'owner', text: 'Capture harness fixture.', createdAt: '2026-01-01T00:00:00.000Z' }],
    proposalActions: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

function span (needle: string): { from: number, to: number } {
  const from = DOC.indexOf(needle)
  if (from < 0) {
    throw new Error(`fixture text not found: ${needle}`)
  }
  return { from, to: from + needle.length }
}

function sceneAnnotations (scene: string): AnnotationSet {
  if (scene === '02-multiple-open-annotations') {
    const a = span('capacity to attribute mental states')
    const b = span('cornerstone of human social cognition')
    const c = span('pass false-belief tasks')
    return {
      generation: 3,
      items: [
        annotation({ state: 'range', ...a, quotedText: 'capacity to attribute mental states' }),
        annotation({ state: 'range', ...b, quotedText: 'cornerstone of human social cognition' }),
        annotation({ state: 'range', ...c, quotedText: 'pass false-belief tasks' })
      ]
    }
  }
  if (scene === '07-deleted-target-point') {
    const seam = span('explain and predict behavior').from
    return {
      generation: 1,
      items: [ annotation({ state: 'point', at: seam, quotedText: 'explain and predict behavior', reason: 'target-deleted' }) ]
    }
  }
  if (scene === '08-orphaned-target-warning') {
    return {
      generation: 1,
      items: [ annotation({ state: 'orphaned', quotedText: 'a passage the owner commented on', reason: 'external-drift' }) ]
    }
  }
  if (scene === '09-overlapping-annotations') {
    const a = span('cornerstone of human')
    const b = span('social cognition')
    return {
      generation: 2,
      items: [
        annotation({ state: 'range', ...a, quotedText: 'cornerstone of human' }),
        annotation({ state: 'range', ...b, quotedText: 'social cognition' })
      ]
    }
  }
  throw new Error(`unknown capture scene: ${scene}`)
}

async function mount (): Promise<void> {
  const dark = document.body.dataset.dark === 'true'
  const scene = document.body.dataset.scene ?? ''
  const host = document.querySelector<HTMLElement>('#editor')
  if (host === null) {
    throw new Error('Visual capture host is missing')
  }

  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: DOC,
      extensions: [
        editorTheme,
        dark ? defaultDark : defaultLight,
        EditorView.lineWrapping,
        lineNumbers(),
        textAnnotationsExtension()
      ]
    })
  })
  view.dispatch({ effects: setAnnotationSessionEffect.of(sceneAnnotations(scene)) })
  view.focus()

  window.annotationsVisualDiagnostics = () => {
    const content = document.querySelector<HTMLElement>('.cm-content')
    return {
      marks: document.querySelectorAll('.cm-textAnnotation-mark').length,
      markers: document.querySelectorAll('.cm-textAnnotation-gutterMarker').length,
      buttons: document.querySelectorAll('button').length,
      contentClientWidth: content?.clientWidth,
      contentScrollWidth: content?.scrollWidth
    }
  }

  await document.fonts.ready
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

window.captureReady = mount()
