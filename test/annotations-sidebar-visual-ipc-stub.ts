/**
 * Installs the fixture responses this capture serves onto the shared
 * preload-bridge double (document-collaboration-ipc-double.ts), rather than
 * re-implementing the bridge itself. The double already normalizes both the
 * `documents-provider` multiplexer and the typed `documents:*` operation
 * channels into one `{ command, payload }` shape and counts calls by
 * operation; this module only supplies what THIS capture's fixtures answer
 * with, and what it must record for the driver to inspect.
 *
 * It also records what the page asked for. For the review controls and the
 * annotation thread the editor carries, the claim that matters is that a
 * click raises the provider's fenced request instead of deciding locally —
 * which is only observable at this bridge.
 */

import type { DocumentCollaborationSession } from '@dts/common/document-collaboration'
import type { LeafNodeJSON } from '@dts/common/documents'
import { documentCollaborationIpcDouble } from './document-collaboration-ipc-double'
import { SCENE_DOCUMENT_PATH } from './annotations-sidebar-scene-fixture'
import editorConfig from './fixtures/editor-config.json'

/**
 * One request the page raised, as it reached the preload bridge: the
 * channel name (the typed `documents:*` channel, or the multiplexer's own
 * inner command) and the raw request the caller sent on it.
 */
export interface RecordedRequest {
  channel: string
  message: unknown
}

let sceneSession: DocumentCollaborationSession | undefined
const recorded: RecordedRequest[] = []

// The capture page carries a window_id search param (see
// annotations-sidebar-visual-capture.mjs's page() query), which makes
// documentTreeStore request this leaf on construction. One pane, holding the
// scene document, is enough for the mounted panel to settle.
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
    case 'get-workspace-collaboration-sessions':
      return sceneSession === undefined ? [] : [sceneSession]
    case 'get-file-modification-status':
      return []
    case 'retrieve-tab-config':
      return sceneLeaf
    default:
      // Every typed documents:* mutation channel answers with the
      // provider's success shape, so the controls' busy state settles
      // the way it does in the app.
      return message.command.startsWith('documents:') ? { ok: true } : undefined
  }
})

// The window-state and config stores read the config at construction, as
// they do in a real window; the capture serves the same snapshot the tab
// persistence harness uses.
documentCollaborationIpcDouble.setSendSyncResponder((channel, message) =>
  channel === 'config-provider' && message?.command === 'get-config' ? editorConfig : undefined
)

export function setAnnotationsSceneSession (session: DocumentCollaborationSession): void {
  sceneSession = session
}

/** Every request the page raised, in order. */
export function recordedRequests (): RecordedRequest[] {
  return recorded
}
