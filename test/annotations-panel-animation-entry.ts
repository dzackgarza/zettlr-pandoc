/**
 * Entry point for measuring annotations panel animation performance and layout isolation.
 * Mounts SplitterGroup with an editor and AnnotationsTab loaded with 100 annotations.
 */

import { documentCollaborationIpcDouble } from './document-collaboration-ipc-double'
import editorConfig from './fixtures/editor-config.json'
import { createApp, h, nextTick, ref, reactive } from 'vue'
import { createPinia } from 'pinia'
import { SplitterGroup, SplitterPanel, SplitterResizeHandle } from 'reka-ui'
import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { defaultDark, editorTheme } from '@common/modules/markdown-editor/theme/editor'
import { textAnnotationsExtension } from '@common/modules/markdown-editor/plugins/text-annotations'
import loadIcons from 'source/common/modules/window-register/load-icons'
import AnnotationsTab from 'source/win-main/sidebar/AnnotationsTab.vue'
import { useDocumentCollaborationStore, useDocumentTreeStore } from 'source/pinia'
import type { TextAnnotation } from '@dts/common/annotation-domain'

const BENCHMARK_PATH = '/tmp/annotations-benchmark-doc.md'
const PANE_ANIMATION_MS = 180

function generateAnnotations(count: number, docLength: number): TextAnnotation[] {
  const items: TextAnnotation[] = []
  const step = Math.max(1, Math.floor((docLength - 100) / count))
  for (let i = 0; i < count; i++) {
    const from = (i * step) % (docLength - 50)
    const to = from + 20
    const id = `bench-ann-${i}`
    items.push({
      annotationId: id,
      documentId: 'benchmark-doc',
      anchor: {
        state: 'range',
        from,
        to,
        quotedText: `Sample quoted passage number ${i}`
      },
      state: i % 5 === 0 ? 'resolved' : 'open',
      messages: [
        {
          messageId: `msg-${i}-1`,
          author: 'owner',
          text: `Annotation instruction preview ${i}: Please verify this mathematical formulation and verify consistency.`,
          createdAt: new Date(Date.now() - i * 60000).toISOString()
        }
      ],
      proposalActions: [],
      createdAt: new Date(Date.now() - i * 60000).toISOString(),
      updatedAt: new Date(Date.now() - i * 60000).toISOString()
    })
  }
  return items
}

export interface StepLayoutResult {
  totalLayoutMs: number
  stepTimes: number[]
  tabWidths: number[]
}

export interface ToggleAnimationResult {
  targetState: 'open' | 'close'
  durationMs: number
  frameCount: number
  avgFrameMs: number
  maxFrameMs: number
  p95FrameMs: number
  droppedFrames: number
  severeDroppedFrames: number
  frameTimesMs: number[]
}

declare global {
  interface Window {
    benchmarkReady: Promise<void>
    measureStepLayouts: (steps: number[]) => StepLayoutResult
    measureToggleAnimation: (targetState: 'open' | 'close') => Promise<ToggleAnimationResult>
    setUnoptimizedMode: (enable: boolean) => void
  }
}

// Inject splitter and animation rules matching App.vue
const appStyle = document.createElement('style')
appStyle.id = 'benchmark-splitter-styles'
appStyle.textContent = `
  .main-panes {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    height: 100%;
  }

  .main-pane {
    min-width: 0;
    overflow: auto;

    &[data-state="collapsed"] {
      visibility: hidden;
      transition: visibility 0s linear 180ms;
    }
  }

  .main-panes.animating {
    .main-pane {
      transition: flex-grow 180ms ease;
      overflow: hidden !important;
    }
    .main-pane-handle { transition: width 180ms ease; }

    [data-pane="annotation-panel"] {
      position: relative;

      > .annotations-tab {
        position: absolute;
        top: 0;
        left: 0;
        bottom: 0;
        width: var(--annotation-panel-width, 320px);
        min-width: var(--annotation-panel-width, 320px);
        pointer-events: none;
      }
    }
  }
`
document.head.appendChild(appStyle)

window.benchmarkReady = (async () => {
  await loadIcons()

  const paragraphs: string[] = []
  for (let i = 0; i < 200; i++) {
    paragraphs.push(`## Section ${i}\nThis is paragraph ${i} containing text and mathematics $f(x) = x^2 + ${i}$.\nSample quoted passage number ${i} continues here with further details.`)
  }
  const fullText = paragraphs.join('\n\n')
  const annotations = generateAnnotations(100, fullText.length)

  // The window-state store reads the file-manager config at construction.
  documentCollaborationIpcDouble.setSendSyncResponder((channel, message) =>
    channel === 'config-provider' && message?.command === 'get-config' ? editorConfig : undefined
  )
  const pinia = createPinia()
  const documentTreeStore = useDocumentTreeStore(pinia)
  documentTreeStore.lastLeafActiveFile = { path: BENCHMARK_PATH, pinned: false }

  const collaborationStore = useDocumentCollaborationStore(pinia)
  const benchmarkSession = {
    documentId: 'benchmark-doc',
    documentPath: BENCHMARK_PATH,
    workingText: fullText,
    workingSha256: 'a'.repeat(64),
    annotations: {
      generation: 1,
      items: annotations
    },
    review: undefined
  }
  collaborationStore.sessionsByDocumentPath[BENCHMARK_PATH] = benchmarkSession
  documentCollaborationIpcDouble.setInvokeResponder(async message =>
    message.command === 'get-workspace-collaboration-sessions' ? [benchmarkSession] : undefined
  )

  const sidebarVisible = ref(true)
  const panesAnimating = ref(false)
  const annotationPanelRef = ref<InstanceType<typeof SplitterPanel> | null>(null)

  const mountWidths = reactive({
    annotationPanel: 320,
    navigationSidebar: 240
  })

  let paneTimer: ReturnType<typeof setTimeout> | undefined

  function applyVisibility(visible: boolean): void {
    const panel = annotationPanelRef.value
    if (panel === null) return
    panesAnimating.value = true
    clearTimeout(paneTimer)
    paneTimer = setTimeout(() => { panesAnimating.value = false }, PANE_ANIMATION_MS)
    if (visible) {
      panel.expand()
      panel.resize(mountWidths.annotationPanel)
    } else {
      panel.collapse()
    }
  }

  const app = createApp({
    setup() {
      return () => h(
        'div',
        { class: 'benchmark-root', style: { width: '100%', height: '100%' } },
        [
          h(
            SplitterGroup,
            {
              direction: 'horizontal',
              class: ['main-panes', panesAnimating.value ? 'animating' : ''],
              style: {
                '--annotation-panel-width': mountWidths.annotationPanel + 'px',
                '--navigation-sidebar-width': mountWidths.navigationSidebar + 'px',
                width: '100%',
                height: '100%'
              }
            },
            () => [
              h(
                SplitterPanel,
                {
                  class: 'main-pane',
                  'data-pane': 'editor',
                  order: 1,
                  minSize: 300
                },
                () => [h('div', { id: 'benchmark-editor', style: { height: '100%', overflow: 'auto' } })]
              ),
              h(
                SplitterResizeHandle,
                {
                  class: ['main-pane-handle', !sidebarVisible.value ? 'collapsed' : ''],
                  'data-pane-handle': 'annotation-panel'
                }
              ),
              h(
                SplitterPanel,
                {
                  ref: annotationPanelRef,
                  class: 'main-pane',
                  'data-pane': 'annotation-panel',
                  sizeUnit: 'px',
                  order: 2,
                  collapsible: true,
                  collapsedSize: 0,
                  minSize: 240,
                  defaultSize: mountWidths.annotationPanel
                },
                () => [h(AnnotationsTab, { workspacePaths: [BENCHMARK_PATH] })]
              )
            ]
          )
        ]
      )
    }
  })

  app.use(pinia)
  const mountEl = document.querySelector('#app')
  if (!mountEl) throw new Error('#app not found')
  app.mount(mountEl)

  await nextTick()

  const editorHost = document.querySelector('#benchmark-editor')
  if (editorHost) {
    new EditorView({
      parent: editorHost,
      state: EditorState.create({
        doc: fullText,
        extensions: [editorTheme, defaultDark, EditorView.lineWrapping, lineNumbers(), textAnnotationsExtension()]
      })
    })
  }

  window.setUnoptimizedMode = (enable: boolean) => {
    const existing = document.getElementById('unoptimized-override')
    if (enable) {
      if (!existing) {
        const style = document.createElement('style')
        style.id = 'unoptimized-override'
        style.textContent = `
          .main-panes.animating [data-pane="annotation-panel"] > .annotations-tab {
            position: static !important;
            width: 100% !important;
            min-width: 0 !important;
          }
          .annotation-workspace-row {
            content-visibility: visible !important;
          }
        `
        document.head.appendChild(style)
      }
    } else {
      existing?.remove()
    }
  }

  window.measureStepLayouts = (steps: number[]): StepLayoutResult => {
    const panel = document.querySelector<HTMLElement>('[data-pane="annotation-panel"]')
    const tab = document.querySelector<HTMLElement>('.annotations-tab')
    const list = document.querySelector<HTMLElement>('.annotation-document-items')
    const mainPanes = document.querySelector<HTMLElement>('.main-panes')
    if (!panel || !tab || !list || !mainPanes) {
      throw new Error('Elements missing for step layout benchmark')
    }

    mainPanes.classList.add('animating')

    let totalLayoutMs = 0
    const stepTimes: number[] = []
    const tabWidths: number[] = []

    for (const w of steps) {
      panel.style.width = w + 'px'
      panel.style.flex = `0 0 ${w}px`
      const t0 = performance.now()
      // Force layout
      void list.offsetHeight
      const t1 = performance.now()
      const tabW = tab.getBoundingClientRect().width
      stepTimes.push(Math.round((t1 - t0) * 100) / 100)
      tabWidths.push(Math.round(tabW))
      totalLayoutMs += (t1 - t0)
    }

    panel.style.width = ''
    panel.style.flex = ''
    mainPanes.classList.remove('animating')

    return {
      totalLayoutMs: Math.round(totalLayoutMs * 100) / 100,
      stepTimes,
      tabWidths
    }
  }

  window.measureToggleAnimation = async (targetState: 'open' | 'close'): Promise<ToggleAnimationResult> => {
    const shouldOpen = targetState === 'open'
    sidebarVisible.value = shouldOpen

    const frameTimestamps: number[] = []
    let running = true

    function frameLoop(now: number) {
      if (!running) return
      frameTimestamps.push(now)
      requestAnimationFrame(frameLoop)
    }

    const startTime = performance.now()
    requestAnimationFrame(frameLoop)

    applyVisibility(shouldOpen)

    await new Promise(r => setTimeout(r, PANE_ANIMATION_MS + 60))
    running = false

    const endTime = performance.now()
    const totalDuration = endTime - startTime

    const intervals: number[] = []
    for (let i = 1; i < frameTimestamps.length; i++) {
      intervals.push(frameTimestamps[i] - frameTimestamps[i - 1])
    }

    const frameCount = intervals.length
    const avgFrame = frameCount > 0 ? intervals.reduce((a, b) => a + b, 0) / frameCount : 0
    const maxFrame = frameCount > 0 ? Math.max(...intervals) : 0
    const sorted = [...intervals].sort((a, b) => a - b)
    const p95Frame = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : 0
    const droppedFrames = intervals.filter(t => t > 16.7).length
    const severeDroppedFrames = intervals.filter(t => t > 33.3).length

    return {
      targetState,
      durationMs: Math.round(totalDuration * 10) / 10,
      frameCount,
      avgFrameMs: Math.round(avgFrame * 10) / 10,
      maxFrameMs: Math.round(maxFrame * 10) / 10,
      p95FrameMs: Math.round(p95Frame * 10) / 10,
      droppedFrames,
      severeDroppedFrames,
      frameTimesMs: intervals.map(t => Math.round(t * 10) / 10)
    }
  }
})()
