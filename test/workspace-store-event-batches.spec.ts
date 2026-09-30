/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Workspace store and batches of filesystem events
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     The main process sends the filesystem events of a burst as
 *                  one batch. The workspace store publishes one change of the
 *                  path list and one change of the descriptors for a batch,
 *                  whatever the number of files in it, and asks the main
 *                  process for nothing that the batch already holds.
 *
 * END HEADER
 */

// Must be the first local import: it installs window.ipc before the stores
// read it at their module top level.
import { documentCollaborationIpcDouble } from './document-collaboration-ipc-double'
import { strict as assert } from 'assert'
import { createPinia, setActivePinia } from 'pinia'
import { watchEffect } from 'vue'
import { useWorkspaceStore } from 'source/pinia/workspace-store'
import type { FSALEventPayload } from 'source/app/service-providers/fsal'
import type { AnyDescriptor, DirDescriptor, OtherFileDescriptor } from 'source/types/common/fsal'

const ROOT = '/workspace'
const BURST = 100

interface FsalRequest {
  command: 'read-path-recursively'|'get-descriptor'
  payload: string|string[]
}

function figure (name: string, size: number = 1): OtherFileDescriptor {
  return { path: `${ROOT}/${name}`, dir: ROOT, name, ext: '.png', type: 'other', size, modtime: 0, creationtime: 0 }
}

const ROOT_DESCRIPTOR: DirDescriptor = {
  path: ROOT,
  dir: '/',
  name: 'workspace',
  type: 'directory',
  size: 0,
  modtime: 0,
  creationtime: 0,
  isGitRepository: false,
  settings: {
    sorting: 'name-up',
    explorer: { displayName: 'inherit', sortMetadataKey: '', foldersFirst: null, projectFilter: 'all' },
    icon: null,
    project: null,
    color: null,
    quartoManifest: null
  }
}

async function settled (): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('The workspace store applies a batch of filesystem events', function () {
  let requests: FsalRequest[]
  let store: ReturnType<typeof useWorkspaceStore>
  let pathListChanges: number
  let descriptorChanges: number

  function send (events: FSALEventPayload[]): void {
    documentCollaborationIpcDouble.emit('fsal-events', events)
  }

  beforeEach(async function () {
    setActivePinia(createPinia())
    documentCollaborationIpcDouble.reset()
    const onDisk = new Map<string, AnyDescriptor>([ [ ROOT, ROOT_DESCRIPTOR ], [ `${ROOT}/first.png`, figure('first.png') ] ])
    requests = []
    documentCollaborationIpcDouble.setSendSyncResponder((channel) => {
      assert.equal(channel, 'config-provider')
      return { app: { openFiles: [], openWorkspaces: [ROOT] } }
    })
    documentCollaborationIpcDouble.setInvokeResponder(async (message) => {
      assert.equal(message.command, 'fsal')
      const request = message.payload as FsalRequest
      requests.push(request)
      if (request.command === 'read-path-recursively') {
        return [...onDisk.keys()]
      }
      assert.ok(Array.isArray(request.payload))
      return request.payload.map(absPath => onDisk.get(absPath))
    })

    store = useWorkspaceStore()
    while (store.descriptorMap.size < onDisk.size) {
      await settled()
    }
    // The store listens to the events after its first load.
    await settled()
    requests = []
    // Each reader runs one time now, and one more time for each publication.
    pathListChanges = -1
    descriptorChanges = -1
    watchEffect(() => {
      assert.ok(store.workspaceMap.get(ROOT) !== undefined)
      pathListChanges++
    }, { flush: 'sync' })
    watchEffect(() => {
      assert.ok(store.descriptorMap.has(ROOT))
      descriptorChanges++
    }, { flush: 'sync' })
  })

  it('of new files with one change of the path list and of the descriptors, and no request to the main process', async function () {
    const added = Array.from({ length: BURST }, (_, i) => figure(`figure-${i}.png`))
    send(added.map(descriptor => ({ event: 'add', descriptor })))
    await settled()

    assert.deepEqual({ pathListChanges, descriptorChanges }, { pathListChanges: 1, descriptorChanges: 1 })
    assert.deepEqual(
      store.pathList,
      [ ROOT, `${ROOT}/first.png`, ...added.map(descriptor => descriptor.path) ]
    )
    for (const descriptor of added) {
      assert.equal(store.descriptorMap.get(descriptor.path), descriptor)
    }
    assert.deepEqual(requests, [])
  })

  it('of changes to known files with the new descriptors and the same path list', async function () {
    const changed = figure('first.png', 2048)
    send([{ event: 'change', descriptor: changed }])
    await settled()

    assert.deepEqual({ pathListChanges, descriptorChanges }, { pathListChanges: 0, descriptorChanges: 1 })
    assert.equal(store.descriptorMap.get(changed.path), changed)
    assert.deepEqual(store.pathList, [ ROOT, changed.path ])
    assert.deepEqual(requests, [])
  })

  it('with the last state of a path that the batch names more than one time', async function () {
    const kept = figure('kept.png')
    const temporary = figure('temporary.png')
    send([
      { event: 'add', descriptor: temporary },
      { event: 'unlink', path: `${ROOT}/first.png` },
      { event: 'unlink', path: kept.path },
      { event: 'add', descriptor: kept },
      { event: 'unlink', path: temporary.path }
    ])
    await settled()

    assert.deepEqual(store.pathList, [ ROOT, kept.path ])
    assert.deepEqual([...store.descriptorMap.keys()], [ ROOT, kept.path ])
    assert.equal(store.descriptorMap.get(kept.path), kept)
    assert.deepEqual({ pathListChanges, descriptorChanges }, { pathListChanges: 1, descriptorChanges: 2 })
    assert.deepEqual(requests, [])
  })
})
