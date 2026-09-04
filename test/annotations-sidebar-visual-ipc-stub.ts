/**
 * Installs the fixture responses this capture serves onto the shared
 * preload-bridge double (document-collaboration-ipc-double.ts), rather than
 * re-implementing the bridge itself. The double already normalizes both the
 * `documents-provider` multiplexer and the typed `documents:*` operation
 * channels into one `{ command, payload }` shape and counts calls by
 * operation; this module only supplies what THIS capture's fixtures answer
 * with, and what it must record for the driver to inspect.
 *
 * It also records what the panel asked for. The review adjudication the
 * editor used to own now lives in this panel, and the claim that matters is
 * that a click raises the provider's fenced request instead of deciding
 * locally — which is only observable at this bridge.
 */

import type { DocumentCollaborationSession } from '@dts/common/document-collaboration'
import type { LeafNodeJSON } from '@dts/common/documents'
import { documentCollaborationIpcDouble } from './document-collaboration-ipc-double'
import { SCENE_DOCUMENT_PATH } from './annotations-sidebar-scene-fixture'

/**
 * One request the panel raised, as it reached the preload bridge: the
 * channel name (the typed `documents:*` channel, or the multiplexer's own
 * inner command) and the raw request the caller sent on it.
 */
export interface RecordedRequest {
  channel: string
  message: unknown
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

let sceneSession: DocumentCollaborationSession | undefined
const recorded: RecordedRequest[] = []

const sceneConfig: SceneConfig = {
  window: { currentSidebarTab: 'annotations' },
  app: { openFiles: [], openWorkspaces: [] },
}

// RelatedFilesTab.vue and OtherFilesTab.vue (both mounted, v-show, inside
// MainSidebar) throw outright without a window_id search param — the
// capture page carries one (see annotations-sidebar-visual-capture.mjs's
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

documentCollaborationIpcDouble.setInvokeResponder(async (message) => {
  recorded.push({ channel: message.command, message: message.payload })
  switch (message.command) {
    case 'get-collaboration-session':
      return sceneSession
    case 'get-file-modification-status':
      return []
    case 'retrieve-tab-config':
      return sceneLeaf
    default:
      // Every typed documents:* mutation channel answers with the
      // provider's success shape, so the panel's own busy state settles
      // the way it does in the app.
      return message.command.startsWith('documents:') ? { ok: true } : undefined
  }
})

documentCollaborationIpcDouble.setSendSyncResponder((channel, message) => {
  if (channel === 'config-provider' && message?.command === 'get-config') {
    return sceneConfig
  }
  return undefined
})

export function setAnnotationsSceneSession (session: DocumentCollaborationSession): void {
  sceneSession = session
}

/** Every request the mounted panel raised, in order. */
export function recordedRequests (): RecordedRequest[] {
  return recorded
}
