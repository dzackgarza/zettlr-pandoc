/**
 * Mounts the recoverable reference-error scene for the Chromium probe
 * (reference-error-surface-probe.cjs). Issue #1, Phase 8 red (workstream 5).
 *
 * The scene: a REAL CodeMirror editor is on screen, and a
 * reference-provider invocation fails (the injected ipc seam rejects —
 * exactly what ipcRenderer.invoke does when the provider handler is missing
 * or throws). The production boundary under test is
 * source/win-main/util/recoverable-reference-errors.ts
 * (invokeReferenceProviderRecoverably), resolved through a webpack context
 * so its absence is a structured, reportable state instead of a bundler
 * crash.
 *
 * Contract exercised here (locked red by
 * test/reference-error-surface.spec.ts):
 *
 * - the failed invocation returns the typed outcome { status: 'failed' } —
 *   never fabricated data, never a rethrow;
 * - EXACTLY ONE closable error toast (the show-toast surface:
 *   #zettlr-toast-container .zettlr-toast.error) appears, naming the failed
 *   operation;
 * - clicking the toast dismisses it, leaving nothing behind;
 * - no error and no unhandled rejection ever reaches the window (an escaped
 *   rejection is what produces the uncloseable runtime-error overlay the
 *   contract forbids);
 * - the editor stays interactive throughout: real keyboard input typed
 *   after the dismissal lands in the document.
 */

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import markdownParser from 'source/common/modules/markdown-editor/parser/markdown-parser'

interface ToastState {
  text: string
  isError: boolean
  dismissLabel: string|null
}

interface ErrorSurfaceRunReport {
  moduleAvailable: boolean
  moduleFailure: string|null
  outcome: unknown
}

declare global {
  interface Window {
    errorSurfaceProbeRun: () => Promise<ErrorSurfaceRunReport>
    errorSurfaceProbeToastState: () => ToastState[]
    errorSurfaceProbeDismiss: () => boolean
    errorSurfaceProbeFocusEditor: () => void
    errorSurfaceProbeEditorText: () => string
    errorSurfaceProbeUncaught: () => string[]
  }
}

// Resolved through a context (not a static import) so the bundle builds and
// reports structured absence while the boundary does not exist yet.
const boundaryContext = require.context('../source/win-main/util/', false, /recoverable-reference-errors\.ts$/)

const uncaught: string[] = []
window.addEventListener('error', event => {
  uncaught.push(`error: ${String(event.error ?? event.message)}`)
})
window.addEventListener('unhandledrejection', event => {
  uncaught.push(`unhandledrejection: ${String(event.reason)}`)
})

const EDITOR_SEED = 'The buffer under the failing index.\n'
let view: EditorView|null = null

window.errorSurfaceProbeRun = async (): Promise<ErrorSurfaceRunReport> => {
  // The real editor the user keeps working in while the index misbehaves.
  const host = document.createElement('div')
  host.id = 'error-surface-editor'
  document.body.appendChild(host)
  view = new EditorView({
    state: EditorState.create({ doc: EDITOR_SEED, extensions: [ markdownParser() ] }),
    parent: host
  })

  const boundaryKey = boundaryContext.keys().find(key => key.includes('recoverable-reference-errors'))
  if (boundaryKey === undefined) {
    return {
      moduleAvailable: false,
      moduleFailure: 'source/win-main/util/recoverable-reference-errors.ts does not exist yet (issue #1 Phase 8 red)',
      outcome: null
    }
  }

  const boundaryModule = boundaryContext(boundaryKey) as {
    invokeReferenceProviderRecoverably?: (
      ipcInvoke: (channel: string, message: { command: string, payload?: unknown }) => Promise<unknown>,
      message: { command: string, payload?: unknown },
      operationLabel: string
    ) => Promise<unknown>
  }
  if (boundaryModule.invokeReferenceProviderRecoverably === undefined) {
    return {
      moduleAvailable: false,
      moduleFailure: 'recoverable-reference-errors.ts exists but exports no invokeReferenceProviderRecoverably',
      outcome: null
    }
  }

  // The injected ipc seam rejects — the real failure shape of
  // ipcRenderer.invoke when the main-process handler is missing or throws.
  const rejectingSeam = async (_channel: string, message: { command: string }): Promise<unknown> => {
    throw new Error(`No handler registered for 'reference-provider' (probe-forced failure of '${message.command}')`)
  }

  const outcome = await boundaryModule.invokeReferenceProviderRecoverably(
    rejectingSeam,
    { command: 'get-snapshot' },
    'Loading workspace references'
  )

  return { moduleAvailable: true, moduleFailure: null, outcome }
}

window.errorSurfaceProbeToastState = (): ToastState[] => {
  return Array.from(document.querySelectorAll<HTMLElement>('#zettlr-toast-container .zettlr-toast')).map(toast => ({
    text: toast.textContent ?? '',
    isError: toast.classList.contains('error'),
    dismissLabel: toast.querySelector('[aria-label]')?.getAttribute('aria-label') ?? null
  }))
}

window.errorSurfaceProbeDismiss = (): boolean => {
  const toast = document.querySelector<HTMLElement>('#zettlr-toast-container .zettlr-toast')
  if (toast === null) {
    return false
  }
  // The toast's own contract: it dismisses on click.
  toast.click()
  return true
}

window.errorSurfaceProbeFocusEditor = (): void => {
  view?.focus()
}

window.errorSurfaceProbeEditorText = (): string => {
  return view?.state.doc.toString() ?? ''
}

window.errorSurfaceProbeUncaught = (): string[] => uncaught
