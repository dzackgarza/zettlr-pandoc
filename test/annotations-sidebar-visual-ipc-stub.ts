/**
 * A real preload-bridge stub for the visual capture entry, serving the
 * fixture session. No imports of its own — the entry imports this FIRST, so
 * window.ipc exists before the Pinia stores it mounts (which read
 * window.ipc at their own module-evaluation top level) are ever imported.
 * Mirrors document-collaboration-ipc-double.ts's header note for the same
 * reason. (Only the type-only import below is exempt: TypeScript erases it
 * entirely, so it carries no runtime module and cannot affect evaluation
 * order.)
 */

import type { DocumentCollaborationSession } from '@dts/common/document-collaboration'
import type { LeafNodeJSON } from '@dts/common/documents'
import { SCENE_DOCUMENT_PATH } from './annotations-sidebar-scene-fixture'

interface DocumentsProviderMessage {
  command: string
  payload?: { path?: string, windowId?: string }
}

interface ConfigProviderMessage {
  command: string
}

/**
 * The MainSidebar mount (for the tab-badge boundary proof) constructs
 * useConfigStore, which reads its config SYNCHRONOUSLY via sendSync at
 * construction. getConfigTemplate() (source/app/service-providers/config)
 * cannot be called from a renderer bundle — it imports `electron`'s
 * main-process-only `app`/`nativeTheme` — so this is the minimal slice of
 * ConfigOptions the mounted sidebar tree actually reads, not a stand-in for
 * the whole template.
 */
interface SceneConfig {
  window: { currentSidebarTab: string }
  app: { openFiles: string[], openWorkspaces: string[] }
}

/**
 * The surface this stub actually serves: the 'documents-provider' calls the
 * mounted collaboration store issues (get-collaboration-session,
 * get-file-modification-status), one synchronous 'config-provider' read
 * (get-config), and no-op listen/send — nothing else this capture ever
 * calls. window.ipc's ambient type (source/types/renderer/ipc-bridge.ts) is
 * the full per-provider contract across every channel in the app; the cast
 * at the bottom is the one named site that gap is bridged, instead of
 * widening this object's own type.
 */
interface AnnotationsSceneIpcBridge {
  invoke: (channel: string, message?: DocumentsProviderMessage) => Promise<DocumentCollaborationSession | string[] | LeafNodeJSON | undefined>
  on: (channel: string, listener: (event: undefined, ...args: never[]) => void) => () => void
  send: (channel: string, ...args: unknown[]) => void
  sendSync: (channel: string, message?: ConfigProviderMessage) => SceneConfig | undefined
}

let sceneSession: DocumentCollaborationSession | undefined

const sceneConfig: SceneConfig = {
  window: { currentSidebarTab: 'annotations' },
  app: { openFiles: [], openWorkspaces: [] },
}

// RelatedFilesTab.vue and OtherFilesTab.vue (both mounted, v-show, inside
// MainSidebar) throw outright without a window_id search param — the
// capture page carries one (see annotations-sidebar-visual-capture.cjs's
// page() query), which makes documentTreeStore request this leaf on
// construction. One pane, holding the scene document, is enough for the
// mounted tree to settle without that pane's own contents ever appearing on
// screen (only AnnotationsTab and the TabBar badge are captured).
const sceneLeaf: LeafNodeJSON = {
  type: 'leaf',
  id: 'scene-leaf',
  openFiles: [{ path: SCENE_DOCUMENT_PATH, pinned: false }],
  activeFile: { path: SCENE_DOCUMENT_PATH, pinned: false },
}

const ipcBridge: AnnotationsSceneIpcBridge = {
  invoke: async (channel, message) => {
    if (channel !== 'documents-provider' || message === undefined) {
      return undefined
    }
    switch (message.command) {
      case 'get-collaboration-session':
        return sceneSession
      case 'get-file-modification-status':
        return []
      case 'retrieve-tab-config':
        return sceneLeaf
      default:
        return undefined
    }
  },
  on: () => () => {},
  send: () => {},
  sendSync: (channel, message) => {
    if (channel === 'config-provider' && message?.command === 'get-config') {
      return sceneConfig
    }
    return undefined
  },
}

window.ipc = ipcBridge as unknown as typeof window.ipc

export function setAnnotationsSceneSession (session: DocumentCollaborationSession): void {
  sceneSession = session
}
