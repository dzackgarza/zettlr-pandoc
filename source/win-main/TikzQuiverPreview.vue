<template>
  <div class="tikz-quiver-preview">
    <div
      v-if="errorMessage !== ''"
      class="tikz-quiver-error"
      role="status"
    >
      {{ errorMessage }}
    </div>
    <iframe
      ref="frame"
      class="tikz-quiver-frame"
      src="./quiver/zettlr-host.html"
      title="Quiver diagram editor"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikzQuiverPreview
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Reusable local host for the forked/vendored Quiver editor.
 *                  The RHS preview pane owns presentation mode and fullscreen
 *                  geometry; this component owns only the live CodeMirror ↔
 *                  Quiver source bridge, macro projection and theme forwarding.
 *                  Embedded and fullscreen states therefore use the same iframe
 *                  and Quiver history rather than competing editor instances.
 *
 * END HEADER
 */

import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { EditorView } from '@codemirror/view'
import type { QuiverMacrosIPCResponse } from 'source/app/lifecycle'
import type { TikzLivePreviewTarget } from '@common/modules/markdown-editor/tikz-live-preview'
import {
  quiverReplacement,
  quiverSessionForBlock,
  quiverSourceForSession,
  type TikzQuiverSourceSession
} from '@common/modules/markdown-editor/tikz-quiver'
import { reportError } from '@common/util/error-reporting'

interface PreviewSession {
  id: string
  source: TikzQuiverSourceSession
}

interface QuiverDiagnostic {
  severity: 'warning'|'error'
  message: string
  from: number
  to: number
}

interface QuiverHostMessage {
  type: string
  sessionId?: string|null
  source?: string
  message?: string
  diagnostics?: QuiverDiagnostic[]
}

const props = defineProps<{
  target: TikzLivePreviewTarget
  editorView: EditorView
  fullscreen: boolean
}>()

const emit = defineEmits<{
  (e: 'exitFullscreen'): void
  (e: 'status', text: string): void
}>()

const frame = ref<HTMLIFrameElement|null>(null)
const session = shallowRef<PreviewSession>({
  id: crypto.randomUUID(),
  source: quiverSessionForBlock(props.target)
})
const macroProjection = shallowRef<QuiverMacrosIPCResponse|null>(null)
const hostReady = ref(false)
const diagnostics = ref<QuiverDiagnostic[]>([])
const errorMessage = ref('')
let themeObserver: MutationObserver|null = null

const currentTheme = (): 'light'|'dark' => document.body.classList.contains('dark') ? 'dark' : 'light'

function sameBlockIdentity (a: TikzQuiverSourceSession, b: TikzQuiverSourceSession): boolean {
  return a.kind === b.kind && a.blockFrom === b.blockFrom
}

function postToQuiver (message: Record<string, unknown>): void {
  const target = frame.value?.contentWindow
  if (target === undefined || target === null) return
  target.postMessage({ ...message, sessionId: session.value.id }, '*')
}

function sendFullLoad (): void {
  if (!hostReady.value || macroProjection.value === null) return
  postToQuiver({
    type: 'zettlr-quiver:load',
    source: quiverSourceForSession(session.value.source),
    macros: macroProjection.value.macros,
    theme: currentTheme()
  })
  postToQuiver({ type: 'zettlr-quiver:display', fullscreen: props.fullscreen })
}

function sendSourceUpdate (): void {
  if (!hostReady.value || macroProjection.value === null) return
  postToQuiver({
    type: 'zettlr-quiver:source',
    source: quiverSourceForSession(session.value.source),
    macros: macroProjection.value.macros
  })
}

watch(
  () => props.target,
  target => {
    if (target.language !== 'tikzcd') {
      throw new Error(`TikzQuiverPreview requires tikzcd source, received ${target.language}`)
    }
    const next = quiverSessionForBlock(target)
    const active = session.value
    const sameIdentity = sameBlockIdentity(active.source, next)
    const sameSource = sameIdentity && active.source.source === next.source

    if (!sameIdentity) {
      session.value = { id: crypto.randomUUID(), source: next }
      diagnostics.value = []
      errorMessage.value = ''
      sendFullLoad()
      return
    }

    // Range movement without byte changes can happen when the document changes
    // before this block. Keep the current Quiver history but refresh its source
    // authority coordinates.
    session.value = { ...active, source: next }
    if (!sameSource) {
      diagnostics.value = []
      errorMessage.value = ''
      sendSourceUpdate()
    }
  }
)

watch(
  () => props.fullscreen,
  fullscreen => {
    if (hostReady.value) {
      postToQuiver({ type: 'zettlr-quiver:display', fullscreen })
    }
  }
)

function onMessage (event: MessageEvent<QuiverHostMessage>): void {
  if (event.source !== frame.value?.contentWindow) return
  const message = event.data
  if (message === null || typeof message !== 'object') return

  if (message.type === 'zettlr-quiver:ready') {
    hostReady.value = true
    sendFullLoad()
    return
  }
  if (message.sessionId !== session.value.id) return

  switch (message.type) {
    case 'zettlr-quiver:loaded':
      diagnostics.value = Array.isArray(message.diagnostics) ? message.diagnostics : []
      errorMessage.value = ''
      break
    case 'zettlr-quiver:change': {
      if (typeof message.source !== 'string') return
      const active = session.value
      const current = props.editorView.state.sliceDoc(active.source.sourceFrom, active.source.sourceTo)
      if (current !== active.source.source) {
        // CodeMirror changed first. Its ordinary change event will update the
        // target prop and reload Quiver from the newer authority bytes; never
        // overwrite that source with a stale iframe export.
        return
      }
      try {
        const replacement = quiverReplacement(active.source, message.source)
        props.editorView.dispatch({
          changes: { from: replacement.from, to: replacement.to, insert: replacement.insert }
        })
        session.value = { ...active, source: replacement.next }
        errorMessage.value = ''
      } catch (error) {
        errorMessage.value = error instanceof Error ? error.message : String(error)
        reportError('Could not synchronize Quiver source into the editor', error)
      }
      break
    }
    case 'zettlr-quiver:error':
      errorMessage.value = message.message ?? 'Quiver reported an unknown error.'
      break
    case 'zettlr-quiver:close-request':
      if (props.fullscreen) emit('exitFullscreen')
      break
  }
}

const statusText = computed(() => {
  if (errorMessage.value !== '') return 'Synchronization issue'
  const errors = diagnostics.value.filter(item => item.severity === 'error').length
  const warnings = diagnostics.value.filter(item => item.severity === 'warning').length
  if (errors > 0) return `${errors} import error${errors === 1 ? '' : 's'}`
  if (warnings > 0) return `${warnings} import warning${warnings === 1 ? '' : 's'}`
  if (!hostReady.value) return 'Loading Quiver…'
  const compilerOnly = macroProjection.value?.unsupported.length ?? 0
  return compilerOnly > 0
    ? `Synced · ${compilerOnly} macro${compilerOnly === 1 ? '' : 's'} compiler-only`
    : 'Synced'
})

watch(statusText, text => { emit('status', text) }, { immediate: true })

onMounted(async () => {
  window.addEventListener('message', onMessage)
  themeObserver = new MutationObserver(() => {
    if (hostReady.value) {
      postToQuiver({ type: 'zettlr-quiver:theme', theme: currentTheme() })
    }
  })
  themeObserver.observe(document.body, { attributes: true, attributeFilter: [ 'class' ] })

  try {
    macroProjection.value = await window.ipc.invoke('quiver-macros')
    sendFullLoad()
  } catch (error) {
    errorMessage.value = `Could not load Quiver macros: ${error instanceof Error ? error.message : String(error)}`
    reportError('Quiver macro projection failed', error)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage)
  themeObserver?.disconnect()
  themeObserver = null
})
</script>

<style scoped lang="less">
.tikz-quiver-preview {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.tikz-quiver-frame {
  flex: 1 1 auto;
  width: 100%;
  min-height: 0;
  border: 0;
  background: white;
}

.tikz-quiver-error {
  flex: 0 0 auto;
  padding: 6px 10px;
  border-bottom: 1px solid rgba(192, 57, 43, 0.35);
  background: rgba(192, 57, 43, 0.08);
  color: #a93226;
  font-size: 0.8rem;
}

:global(body.dark .tikz-quiver-error) {
  color: #e67e73;
}
</style>
