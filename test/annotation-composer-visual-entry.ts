/**
 * Mounts the production AnnotationCreateDialog (M6) for isolated visual
 * capture — the plan's scene `01-selection-composer`, gated against
 * mockup-2-creation-dialog.png. Modeled on
 * reference-rename-preview-entry.ts: webpack bundles this against the
 * production renderer config (vue-loader, aliases), a bare real EditorView
 * stands in for the pane behind the dialog (the dialog only needs a real
 * EditorView to attach its live draft-tracking compartment to — it renders
 * no CodeMirror decorations of its own), and the dialog itself is the REAL
 * component, not a stand-in.
 */

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { createApp, nextTick } from 'vue'
import AnnotationCreateDialog from 'source/win-main/AnnotationCreateDialog.vue'

declare global {
  interface Window {
    annotationComposerProbeMount: () => Promise<void>
    /** Types into the instruction textarea the way a real keystroke would (dispatches 'input' so v-model sees it). */
    annotationComposerProbeType: (text: string) => Promise<void>
  }
}

const DOCUMENT_TEXT = [
  '# AI Product Strategy',
  '',
  'This document outlines our strategy for building AI-native features',
  'that delight users and create durable value.',
  '',
  '## Guiding Principles',
  '',
  '- Human-in-the-loop by default',
  '- Trust through transparency – Make AI behavior understandable,',
  '  controllable, and auditable.',
  '- Ship iteratively'
].join('\n')

// The capture never calls Save, so the IPC stub only has to exist, not
// answer a real create-annotation request.
window.ipc = {
  invoke: async () => ({ ok: false, code: 'INTERNAL_ERROR', message: 'not wired in the capture probe' })
} as unknown as typeof window.ipc

// AnnotationCreateDialog renders its excerpt through md2html, which calls
// this for every citation node — the capture excerpt has none, but the
// callback must exist before md2html runs.
window.getCitationCallback = () => () => undefined

window.annotationComposerProbeMount = async (): Promise<void> => {
  const editorContainer = document.createElement('div')
  editorContainer.id = 'editor-backdrop'
  document.getElementById('app')?.appendChild(editorContainer)

  const editorView = new EditorView({
    state: EditorState.create({ doc: DOCUMENT_TEXT }),
    parent: editorContainer
  })

  const from = DOCUMENT_TEXT.indexOf('Trust through transparency')
  const to = from + 'Trust through transparency – Make AI behavior understandable,\n  controllable, and auditable.'.length
  const quotedText = DOCUMENT_TEXT.slice(from, to)

  const dialogContainer = document.createElement('div')
  document.getElementById('app')?.appendChild(dialogContainer)

  createApp(AnnotationCreateDialog, {
    editorView,
    documentPath: '/capture/ai-product-strategy.md',
    from,
    to,
    quotedText,
    annotationGeneration: 0
  }).mount(dialogContainer)

  await nextTick()
  await document.fonts.ready
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

window.annotationComposerProbeType = async (text: string): Promise<void> => {
  const textarea = document.querySelector<HTMLTextAreaElement>('.annotation-create-dialog [data-instruction]')
  if (textarea === null) {
    return
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(textarea, text)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}
