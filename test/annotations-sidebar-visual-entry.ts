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
import MainSidebar from 'source/win-main/sidebar/MainSidebar.vue'
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
    /**
     * The rendered text of the annotations tab's TabBar badge, from a REAL
     * mounted MainSidebar.vue sharing the same Pinia session as the panel
     * above — the boundary proof that MainSidebar's own wiring (not just
     * openAnnotationCount() in isolation) puts the open-only count on
     * screen. Null if MainSidebar renders no badge at all.
     */
    annotationsSceneMainSidebarBadge: () => string | null
  }
}

const sceneSession = buildSceneSession()
setAnnotationsSceneSession(sceneSession)

async function mount (): Promise<void> {
  await loadIcons()

  // One shared Pinia instance for both apps below: MainSidebar's own tab
  // badge must read the SAME collaboration session and active file the
  // panel does, not a second independent copy.
  const pinia = createPinia()

  const app = createApp(AnnotationsTab)
  app.use(pinia)

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

  // A second, off-screen mount of the real MainSidebar.vue — the S10
  // boundary proof needs the REAL tab-badge wiring rendered, not just the
  // pure counting function it reads from.
  const sidebarHost = document.createElement('div')
  sidebarHost.style.position = 'absolute'
  sidebarHost.style.left = '-9999px'
  document.body.appendChild(sidebarHost)
  const sidebarApp = createApp(MainSidebar)
  sidebarApp.use(pinia)
  sidebarApp.mount(sidebarHost)
  await nextTick()

  window.annotationsSceneMainSidebarBadge = () => {
    return sidebarHost.querySelector('.system-tab[data-target="annotations-panel"] .system-tab-badge')?.textContent ?? null
  }

  window.annotationsSceneSelect = async (annotationId) => {
    collaborationStore.selectAnnotation(annotationId)
    await nextTick()
  }
  window.annotationsSceneSetShowResolved = async (value) => {
    collaborationStore.toggleShowResolved(value)
    await nextTick()
  }
  // Scoped to `host` (the standalone panel mount), not `document`: the
  // off-screen MainSidebar mount below renders its OWN nested AnnotationsTab
  // instance (same shared session) for the badge proof, and an unscoped
  // query would double-count both mounts' cards.
  window.annotationsSceneDiagnostics = () => ({
    openCount: sceneSession.annotations.items.filter(a => a.state === 'open').length,
    listCardCount: host.querySelectorAll('.annotation-list-item').length,
    resolvedDisclosurePresent: host.querySelector('.annotation-resolved-disclosure') !== null,
    inspectorPresent: host.querySelector('.annotation-inspector') !== null,
    inspectorMode: host.querySelector('.annotations-tab')?.getAttribute('data-inspector-mode') ?? '',
  })

  await document.fonts.ready
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

window.captureReady = mount()
