/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Document annotation IPC wiring specs (M6, WU-14)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The pure transition algebra (bounds, generation fencing,
 *                  owner-only lifecycle moves) is already exhaustively
 *                  proved by annotation-transitions.spec.ts. This spec
 *                  proves the layer M6 adds on top of it: the six
 *                  'documents:*' annotation channels this milestone
 *                  registers actually reach CollaborationApplicationService
 *                  through a REAL DocumentManager (the provider-shell
 *                  pattern used by documents-provider-navigation.spec.ts and
 *                  annotation-agent-api.spec.ts — real files, real sidecar,
 *                  the REAL registered ipcMain.handle listener, not the
 *                  DocumentManager method called directly).
 *
 *                  Four wiring-specific concerns that only exist at this
 *                  layer: a path with no open document is refused rather
 *                  than crashing on an undefined documentId; a real bounds
 *                  violation and a real generation mismatch both survive
 *                  the trip through the channel unchanged; and the channel
 *                  hardcodes actor: 'owner' from server-side code, so a
 *                  forged 'actor' field on the wire payload (there is no
 *                  typed field for it — this simulates a hand-crafted
 *                  postMessage bypassing the compile-time contract) is
 *                  never read.
 *
 * END HEADER
 */

import { ipcMainHandlers } from './headless-electron-harness.cjs'
import { strict as assert } from 'assert'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import DocumentManager from 'source/app/service-providers/documents'
import LogProvider from 'source/app/service-providers/log'
import type { AnnotationFailure } from 'source/app/service-providers/documents/document-collaboration-application-service'
import type { TextAnnotation, AnnotationMessage } from '@dts/common/annotation-domain'
import type { CodeFileDescriptor } from '@dts/common/fsal'
import type { AppServiceContainer } from 'source/app/app-service-container'

type IpcHandler = (event: unknown, input: unknown) => Promise<unknown>

/** The REAL registered listener for one 'documents:*' channel. */
function handler (channel: string): IpcHandler {
  const registered = ipcMainHandlers.get(channel) as IpcHandler|undefined
  assert.ok(registered !== undefined, `constructing DocumentManager must register ${channel}`)
  return registered
}

async function invoke<T> (channel: string, input: unknown): Promise<T> {
  return await handler(channel)(undefined, input) as T
}

function isFailure (result: unknown): result is AnnotationFailure {
  return typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === false
}

describe('Document annotation IPC (M6, WU-14)', function () {
  let scratch: string
  let provider: DocumentManager

  function descriptorFor (filePath: string): CodeFileDescriptor {
    const stat = statSync(filePath)
    return {
      path: filePath,
      dir: path.dirname(filePath),
      name: path.basename(filePath),
      ext: path.extname(filePath),
      type: 'code',
      size: stat.size,
      modtime: stat.mtimeMs,
      creationtime: stat.birthtimeMs,
      bom: '',
      linefeed: '\n'
    }
  }

  function normalizedRead (filePath: string): string {
    return readFileSync(filePath, 'utf8').split(/\r\n|\n\r|\n|\r/g).join('\n')
  }

  async function createProvider (): Promise<DocumentManager> {
    const watcherSeam = {
      on: () => {},
      getWatched: () => ({}),
      watchPath: (_path: string) => {},
      unwatchPath: (_path: string) => {},
      shutdown: async () => {}
    }
    const appSeam = {
      log: new LogProvider(),
      config: {
        get: () => ({
          app: { openFiles: [], openWorkspaces: [scratch] },
          system: { avoidNewTabs: false },
          editor: { autoSave: 'off' as const },
          files: {
            images: { openWith: 'zettlr' as const },
            pdf: { openWith: 'zettlr' as const }
          },
          appLang: 'en-US',
          alwaysReloadFiles: false
        }),
        addPath: (_path: string) => false,
        set: (_key: string, _value: unknown) => {}
      },
      fsal: {
        getWatchdog: () => watcherSeam,
        testAccess: async () => true,
        getDescriptorForAnySupportedFile: async (filePath: string) => descriptorFor(filePath),
        loadAnySupportedFile: async (filePath: string) => normalizedRead(filePath),
        writeTextFile: async (filePath: string, content: string) => {
          writeFileSync(filePath, content, 'utf8')
        },
        getDescriptorFor: async (filePath: string) => descriptorFor(filePath),
        getFilesystemMetadata: async (_filePath: string) => ({ modtime: 0 }),
        readDirectoryRecursively: async (workspacePath: string) =>
          readdirSync(workspacePath, { recursive: true, withFileTypes: true })
            .filter(entry => entry.isFile())
            .map(entry => path.join(entry.parentPath, entry.name))
      },
      citeproc: { synchronizeDatabases: async (_libraries: string[]) => {} },
      recentDocs: { add: (_path: string) => {} },
      stats: { updateCounts: (_words: number, _chars: number) => {} },
      windows: {
        askSaveChanges: async (_detail?: string) => ({ response: 2, checkboxChecked: false }),
        getFirstMainWindow: () => undefined,
        getMainWindowKey: (_window: unknown) => ''
      },
      references: {
        reportAuthorityBuffer: (_filePath: string) => {},
        dropAuthorityBuffer: (_filePath: string) => {}
      }
    }

    const manager = new DocumentManager(appSeam as unknown as AppServiceContainer)
    await manager.boot()
    return manager
  }

  async function openFile (fileName: string, content: string): Promise<string> {
    const filePath = path.join(scratch, fileName)
    writeFileSync(filePath, content, 'utf8')
    await provider.getDocument(filePath)
    const documentId = provider.getDocumentId(filePath)
    assert.ok(documentId !== undefined, 'the opened file must be assigned a documentId')
    return filePath
  }

  beforeEach(async function () {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'zettlr-annotation-ipc-'))
    provider = await createProvider()
  })

  afterEach(async function () {
    await provider.shutdown()
    rmSync(scratch, { recursive: true, force: true })
  })

  it('creates an annotation through documents:create-annotation and reaches the real application service', async function () {
    const content = 'Trust through transparency – make AI behavior understandable.\n'
    const filePath = await openFile('strategy.md', content)
    const from = content.indexOf('Trust through transparency')
    const to = from + 'Trust through transparency'.length

    const created = await invoke<TextAnnotation | AnnotationFailure>('documents:create-annotation', {
      path: filePath,
      from,
      to,
      instruction: 'Expand this with concrete examples.',
      expectedAnnotationGeneration: 0
    })

    assert.ok(!isFailure(created), `expected a created annotation, got ${JSON.stringify(created)}`)
    const annotation = created as TextAnnotation
    assert.deepEqual(annotation.anchor, { state: 'range', from, to, quotedText: 'Trust through transparency' })
    assert.equal(annotation.messages[0].author, 'owner')
    assert.equal(annotation.messages[0].text, 'Expand this with concrete examples.')
  })

  it('refuses documents:create-annotation for a path with no open document', async function () {
    const result = await invoke<TextAnnotation | AnnotationFailure>('documents:create-annotation', {
      path: path.join(scratch, 'never-opened.md'),
      from: 0,
      to: 1,
      instruction: 'x',
      expectedAnnotationGeneration: 0
    })
    assert.ok(isFailure(result), 'an unresolved path must be refused, not throw')
    assert.equal(result.code, 'DOCUMENT_NOT_FOUND')
  })

  it('surfaces a real coordinate bounds violation through the channel unchanged', async function () {
    const content = 'short\n'
    const filePath = await openFile('short.md', content)

    const result = await invoke<TextAnnotation | AnnotationFailure>('documents:create-annotation', {
      path: filePath,
      from: 0,
      to: content.length + 50,
      instruction: 'x',
      expectedAnnotationGeneration: 0
    })
    assert.ok(isFailure(result), 'a target past the end of the document must be refused')
    assert.equal(result.code, 'INVALID_PARAMS')
  })

  it('surfaces a real generation mismatch through the channel unchanged', async function () {
    const content = 'One sentence here. Another sentence here.\n'
    const filePath = await openFile('two-sentences.md', content)
    const firstFrom = content.indexOf('One sentence here.')
    const firstTo = firstFrom + 'One sentence here.'.length

    const first = await invoke<TextAnnotation | AnnotationFailure>('documents:create-annotation', {
      path: filePath, from: firstFrom, to: firstTo, instruction: 'first', expectedAnnotationGeneration: 0
    })
    assert.ok(!isFailure(first), 'the first creation must succeed at generation 0')

    const secondFrom = content.indexOf('Another sentence here.')
    const secondTo = secondFrom + 'Another sentence here.'.length
    const stale = await invoke<TextAnnotation | AnnotationFailure>('documents:create-annotation', {
      // Still claiming generation 0, which the first creation already advanced past.
      path: filePath, from: secondFrom, to: secondTo, instruction: 'second', expectedAnnotationGeneration: 0
    })
    assert.ok(isFailure(stale), 'a stale expectedAnnotationGeneration must be refused')
    assert.equal(stale.code, 'ANNOTATION_GENERATION_MISMATCH')
  })

  it('hardcodes actor: owner and never reads a forged actor field off the wire payload', async function () {
    const content = 'Some annotatable sentence.\n'
    const filePath = await openFile('forged-actor.md', content)
    const from = content.indexOf('annotatable')
    const to = from + 'annotatable'.length

    // No CreateAnnotationIpcInput field carries 'actor' — this simulates a
    // hand-crafted postMessage from a compromised renderer, not a value any
    // typed call site could produce.
    const forged = {
      path: filePath, from, to, instruction: 'forged', expectedAnnotationGeneration: 0, actor: 'agent'
    }
    const created = await invoke<TextAnnotation | AnnotationFailure>('documents:create-annotation', forged)
    assert.ok(!isFailure(created), 'creation must still succeed')
    assert.equal((created as TextAnnotation).messages[0].author, 'owner', 'the forged actor field must never reach the transition')
  })

  it('wires documents:add-annotation-message to the real thread', async function () {
    const content = 'Annotate this clause please.\n'
    const filePath = await openFile('message.md', content)
    const from = content.indexOf('this clause')
    const to = from + 'this clause'.length

    const created = await invoke<TextAnnotation>('documents:create-annotation', {
      path: filePath, from, to, instruction: 'first turn', expectedAnnotationGeneration: 0
    })

    const messaged = await invoke<AnnotationMessage | AnnotationFailure>('documents:add-annotation-message', {
      path: filePath,
      annotationId: created.annotationId,
      text: 'a second turn',
      expectedAnnotationGeneration: 1
    })
    assert.ok(!isFailure(messaged), `expected a posted message, got ${JSON.stringify(messaged)}`)
    assert.equal((messaged as AnnotationMessage).text, 'a second turn')
    assert.equal((messaged as AnnotationMessage).author, 'owner')
  })

  it('wires documents:resolve-annotation and documents:reopen-annotation to the real lifecycle', async function () {
    const content = 'Resolve and reopen this.\n'
    const filePath = await openFile('lifecycle.md', content)
    const from = content.indexOf('this')
    const to = from + 'this'.length

    const created = await invoke<TextAnnotation>('documents:create-annotation', {
      path: filePath, from, to, instruction: 'lifecycle', expectedAnnotationGeneration: 0
    })

    const resolved = await invoke<TextAnnotation | AnnotationFailure>('documents:resolve-annotation', {
      path: filePath, annotationId: created.annotationId, expectedAnnotationGeneration: 1
    })
    assert.ok(!isFailure(resolved), `expected a resolved annotation, got ${JSON.stringify(resolved)}`)
    assert.equal((resolved as TextAnnotation).state, 'resolved')

    const reopened = await invoke<TextAnnotation | AnnotationFailure>('documents:reopen-annotation', {
      path: filePath, annotationId: created.annotationId, expectedAnnotationGeneration: 2
    })
    assert.ok(!isFailure(reopened), `expected a reopened annotation, got ${JSON.stringify(reopened)}`)
    assert.equal((reopened as TextAnnotation).state, 'open')
  })

  it('wires documents:reattach-annotation to a freshly picked range', async function () {
    const content = 'First target here. Second target here.\n'
    const filePath = await openFile('reattach.md', content)
    const firstFrom = content.indexOf('First target')
    const firstTo = firstFrom + 'First target'.length

    const created = await invoke<TextAnnotation>('documents:create-annotation', {
      path: filePath, from: firstFrom, to: firstTo, instruction: 'reattach me', expectedAnnotationGeneration: 0
    })

    const secondFrom = content.indexOf('Second target')
    const secondTo = secondFrom + 'Second target'.length
    const reattached = await invoke<TextAnnotation | AnnotationFailure>('documents:reattach-annotation', {
      path: filePath,
      annotationId: created.annotationId,
      from: secondFrom,
      to: secondTo,
      expectedAnnotationGeneration: 1
    })
    assert.ok(!isFailure(reattached), `expected a reattached annotation, got ${JSON.stringify(reattached)}`)
    assert.deepEqual(
      (reattached as TextAnnotation).anchor,
      // quotedText survives the move unchanged (I1) — it still reads the ORIGINAL target.
      { state: 'range', from: secondFrom, to: secondTo, quotedText: 'First target' }
    )
  })

  it('wires documents:delete-annotation to the real removal', async function () {
    const content = 'Delete this annotation.\n'
    const filePath = await openFile('delete.md', content)
    const from = content.indexOf('this annotation')
    const to = from + 'this annotation'.length

    const created = await invoke<TextAnnotation>('documents:create-annotation', {
      path: filePath, from, to, instruction: 'delete me', expectedAnnotationGeneration: 0
    })

    const deleted = await invoke<TextAnnotation | AnnotationFailure>('documents:delete-annotation', {
      path: filePath, annotationId: created.annotationId, expectedAnnotationGeneration: 1
    })
    assert.ok(!isFailure(deleted), `expected the deletion to succeed, got ${JSON.stringify(deleted)}`)

    const session = await invoke<{ annotations: { items: TextAnnotation[] } } | undefined>(
      'documents-provider',
      { command: 'get-collaboration-session', payload: { path: filePath } }
    )
    assert.ok(session !== undefined)
    assert.equal(
      session?.annotations.items.some(item => item.annotationId === created.annotationId),
      false,
      'the deleted annotation must be gone from the session'
    )
  })
})
