/**
 * Mounts the production AnnotationsTab.vue against the same fixture session
 * the unit spec uses (annotations-sidebar-scene-fixture.ts), for the M7
 * structural-conformance captures (plan section 4, scenes 03/05/10/11). The
 * harness computes no render output itself — every card, pill, and count on
 * screen is the real component reading a real Pinia store, exactly the path
 * the app takes, with only the IPC transport stubbed to serve the fixture.
 */

// Must be the first local import: it installs window.ipc as a side effect,
// before the Pinia stores below (imported transitively through
// AnnotationsTab) read window.ipc at their own module top level.
import { setAnnotationsSceneSession } from './annotations-sidebar-visual-ipc-stub'
import { createApp, nextTick } from 'vue'
import { createPinia } from 'pinia'
import loadIcons from 'source/common/modules/window-register/load-icons'
import AnnotationsTab from 'source/win-main/sidebar/AnnotationsTab.vue'
import { useDocumentCollaborationStore, useDocumentTreeStore } from 'source/pinia'
import { buildSceneSession, SCENE_DOCUMENT_PATH } from './annotations-sidebar-scene-fixture'

declare global {
  interface Window {
    captureReady: Promise<void>
    annotationsSceneSelect: (annotationId: string | null) => Promise<void>
    annotationsSceneSetShowResolved: (value: boolean) => Promise<void>
    annotationsSceneDiagnostics: () => {
      openCount: number
      listCardCount: number
      resolvedDisclosurePresent: boolean
      inspectorPresent: boolean
      inspectorMode: string
    }
  }
}

const sceneSession = buildSceneSession()
setAnnotationsSceneSession(sceneSession)

async function mount (): Promise<void> {
  await loadIcons()

  const app = createApp(AnnotationsTab)
  app.use(createPinia())

  const documentTreeStore = useDocumentTreeStore()
  documentTreeStore.lastLeafActiveFile = { path: SCENE_DOCUMENT_PATH, pinned: false }

  const collaborationStore = useDocumentCollaborationStore()

  const host = document.querySelector<HTMLElement>('#app')
  if (host === null) {
    throw new Error('Visual capture host is missing')
  }
  app.mount(host)

  await collaborationStore.ensureSession(SCENE_DOCUMENT_PATH)
  await nextTick()

  window.annotationsSceneSelect = async (annotationId) => {
    collaborationStore.selectAnnotation(annotationId)
    await nextTick()
  }
  window.annotationsSceneSetShowResolved = async (value) => {
    collaborationStore.toggleShowResolved(value)
    await nextTick()
  }
  window.annotationsSceneDiagnostics = () => ({
    openCount: sceneSession.annotations.items.filter(a => a.state === 'open').length,
    listCardCount: document.querySelectorAll('.annotation-list-item').length,
    resolvedDisclosurePresent: document.querySelector('.annotation-resolved-disclosure') !== null,
    inspectorPresent: document.querySelector('.annotation-inspector') !== null,
    inspectorMode: document.querySelector('.annotations-tab')?.getAttribute('data-inspector-mode') ?? '',
  })

  await document.fonts.ready
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

window.captureReady = mount()
