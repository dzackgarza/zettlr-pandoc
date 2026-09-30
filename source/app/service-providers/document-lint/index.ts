/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        DocumentLintProvider
 * CVM-Role:        Service Provider
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The one main-process owner of document linting. The editor
 *                  and the agent API lint through it, and it keeps a durable
 *                  cache of every workspace document's Flowmark diagnostics.
 *
 *                  A cached result is current while its key still matches:
 *                  the revision of the text it linted, plus every input to
 *                  the Flowmark run (the installed Flowmark, this build, the
 *                  definition sites of the other documents, the macro
 *                  sources, the TikZ template graph, the document's
 *                  bibliographies and project roots, and the Flowmark config
 *                  files above it). A lint whose key matches is answered from
 *                  the cache without running Flowmark.
 *
 *                  A background queue keeps the workspace current: at boot,
 *                  after a file system change, after a Flowmark update and
 *                  when a reader finds a stale entry, it re-lints each
 *                  document whose key no longer matches. The cache persists
 *                  in userData, so a restart keeps every result whose inputs
 *                  have not changed. While the queue runs, it is one
 *                  long-running task with its progress.
 *
 * END HEADER
 */

import { createHash } from 'crypto'
import { readdir, readFile, rename, stat, writeFile } from 'fs/promises'
import { availableParallelism } from 'os'
import path from 'path'
import ProviderContract from '../provider-contract'
import type LogProvider from '@providers/log'
import type LongRunningTaskProvider from '@providers/long-running-tasks'
import type { LongRunningTask } from '@providers/long-running-tasks/task'
import { trans } from 'source/common/i18n-main'
import type { FSALEventPayload } from '@providers/fsal'
import type FSAL from '@providers/fsal'
import type { ConfigOptions } from '@providers/config/get-config-template'
import type { WorkspaceReferenceState } from '@providers/references/reference-index'
import { sha256Text } from '@common/util/sha256'
import { hashDocumentSource } from '@common/pandoc-util/extract-references'
import type { FixAllEdit, FixAllPlan } from '@dts/common/fix-all'
import { hasMarkdownExt } from '@common/util/file-extention-checks'
import {
  createDocumentLintContext,
  lintDocumentText,
  type DocumentLintDiagnostic
} from '../../util/document-lint'
import { documentLintAuthority } from '../../util/document-bibliographies'
import { otherDefinitionSites, wikilinkResolutions } from '../../util/flowmark-lint-context'
import type { WikilinkIndex } from '@common/util/wikilink-resolution'
import { flowmarkInstallIdentity } from '../../util/flowmark-runtime'
import { resolveTikzRenderConfig } from '../../util/resolve-tikz-render-config'
import { tikzTemplateDependencyHash } from 'tikz-workbench/src/tikz-render'

/** One document's lint result and the key it was computed under. */
export interface DocumentLintRecord {
  /** sha256 of the linted text: the document revision the diagnostics are for. */
  revision: string
  /** Digest of every other input to the Flowmark run. */
  inputs: string
  /** ISO 8601 time the Flowmark run finished. */
  lintedAt: string
  diagnostics: DocumentLintDiagnostic[]
  /** False when Flowmark itself failed; such a record is never cached. */
  complete: boolean
}

export interface DocumentLintLookup {
  record?: DocumentLintRecord
  /** True when the record's key matches the document's current text and inputs. */
  current: boolean
}

/** A document's current text, as the document authority or the disk has it. */
export interface DocumentLintSource {
  path: string
  text: string
}

export interface DocumentLintDependencies {
  log: LogProvider
  config: {
    get: () => {
      export: { cslLibrary: string }
      tikz: ConfigOptions['tikz']
      editor: { lint: { flowmark: ConfigOptions['editor']['lint']['flowmark'] } }
    }
  }
  /** Open buffers win over the disk. */
  buffers: { readMarkdownBufferContent: (filePath: string) => string | undefined }
  references?: { getSnapshot: () => WorkspaceReferenceState }
  /** The workspace's wikilink index, which resolves the document's wikilinks. */
  links?: { index: WikilinkIndex }
  fsal?: Pick<FSAL, 'getDescriptorFor' | 'getAnyDirectoryDescriptor' | 'getAllLoadedDescriptors' | 'on' | 'off'>
  /** Shows the background queue in the status bar. */
  lrt?: Pick<LongRunningTaskProvider, 'registerTask' | 'settleTask'>
  homeDirectory: string
  env: NodeJS.ProcessEnv
  userDataDirectory: string
  /** The running build, so a new build does not reuse results of another's context. */
  buildIdentity: string
}

interface CacheFile {
  entries: Record<string, DocumentLintRecord>
}

const CACHE_FILE = 'document-lint-cache.json'
// A change arrives as a burst of file system events; one reconcile follows it.
const RECONCILE_DEBOUNCE_MS = 1_000
const PERSIST_DEBOUNCE_MS = 2_000
// Each Flowmark run is one single-threaded Python process.
const WORKER_COUNT = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)))
// flowmark/config.py searches each directory upward for these names.
const FLOWMARK_CONFIG_NAMES = [ '.flowmark.toml', 'flowmark.toml', 'pyproject.toml' ]

function digest (value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * The fixes of one pass: every diagnostic's `fix` in source order, skipping
 * one that overlaps a fix already taken. A skipped fix remains a finding for
 * the next run, as in ESLint's SourceCodeFixer (eslint/lib/linter).
 */
export function fixEdits (diagnostics: readonly DocumentLintDiagnostic[]): FixAllEdit[] {
  const edits: FixAllEdit[] = []
  let cursor = 0
  const fixable = diagnostics
    .filter(diagnostic => diagnostic.fix !== undefined)
    .sort((a, b) => a.from - b.from || a.to - b.to)
  for (const diagnostic of fixable) {
    if (diagnostic.fix === undefined || diagnostic.from < cursor) {
      continue
    }
    edits.push({ from: diagnostic.from, to: diagnostic.to, insert: diagnostic.fix.replacement, rule: diagnostic.rule })
    cursor = diagnostic.to
  }
  return edits
}

function isRecord (value: unknown): value is DocumentLintRecord {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Partial<DocumentLintRecord>
  return typeof candidate.revision === 'string' &&
    typeof candidate.inputs === 'string' &&
    typeof candidate.lintedAt === 'string' &&
    Array.isArray(candidate.diagnostics) &&
    candidate.complete === true
}

/** Memoizes file stamps across the documents of one key computation. */
class StampReader {
  private readonly stamps = new Map<string, Promise<string>>()

  async stamp (filePath: string): Promise<string> {
    let pending = this.stamps.get(filePath)
    if (pending === undefined) {
      pending = stat(filePath).then(
        info => `${filePath}\0${info.mtimeMs}\0${info.size}`,
        () => `${filePath}\0absent`
      )
      this.stamps.set(filePath, pending)
    }
    return await pending
  }

  async tree (root: string): Promise<string[]> {
    let entries
    try {
      entries = await readdir(root, { recursive: true, withFileTypes: true })
    } catch {
      return [await this.stamp(root)]
    }
    const files = entries
      .filter(entry => entry.isFile())
      .map(entry => path.join(entry.parentPath, entry.name))
      .sort()
    return await Promise.all(files.map(async file => await this.stamp(file)))
  }

  async flowmarkConfig (documentPath: string): Promise<string[]> {
    const candidates: string[] = []
    let directory = path.dirname(documentPath)
    for (;;) {
      candidates.push(...FLOWMARK_CONFIG_NAMES.map(name => path.join(directory, name)))
      const parent = path.dirname(directory)
      if (parent === directory) {
        break
      }
      directory = parent
    }
    const stamps = await Promise.all(candidates.map(async file => await this.stamp(file)))
    return stamps.filter(stamp => !stamp.endsWith('\0absent'))
  }
}

export default class DocumentLintProvider extends ProviderContract {
  private readonly entries = new Map<string, DocumentLintRecord>()
  private readonly queue = new Set<string>()
  private readonly inFlight = new Map<string, Promise<DocumentLintRecord>>()
  private activeWorkers = 0
  /** The status bar task of the running queue, from its first document until it drains. */
  private batch: { task: LongRunningTask, total: number, done: number, failed: number } | undefined
  private flowmarkIdentity: string | undefined
  private reconcileTimer: NodeJS.Timeout | undefined
  private persistTimer: NodeJS.Timeout | undefined
  private booted = false
  private stopped = false

  private readonly onFsalEvents = (events: FSALEventPayload[]): void => {
    for (const payload of events) {
      if (payload.event === 'unlink') {
        if (this.entries.delete(payload.path)) {
          this.schedulePersist()
        }
      } else if ((payload.event === 'add' || payload.event === 'change') && hasMarkdownExt(payload.descriptor.path)) {
        this.scheduleReconcile()
      }
    }
  }

  constructor (private readonly deps: DocumentLintDependencies) {
    super()
  }

  private get cachePath (): string {
    return path.join(this.deps.userDataDirectory, CACHE_FILE)
  }

  async boot (): Promise<void> {
    await this.loadCache()
    await this.refreshFlowmarkIdentity()
    this.deps.fsal?.on('fsal-events', this.onFsalEvents)
    this.booted = true
    this.scheduleReconcile()
  }

  async shutdown (): Promise<void> {
    this.stopped = true
    this.deps.fsal?.off('fsal-events', this.onFsalEvents)
    clearTimeout(this.reconcileTimer)
    clearTimeout(this.persistTimer)
    await this.persist()
  }

  /** Call after the Flowmark install changed: every result it produced is outdated. */
  async flowmarkUpdated (): Promise<void> {
    // Before boot there is nothing to invalidate; boot reads the identity.
    if (!this.booted) {
      return
    }
    await this.refreshFlowmarkIdentity()
    this.scheduleReconcile()
  }

  /**
   * Lint a document, answering from the cache when its key matches. A
   * document without a path (an unsaved buffer) is linted and not cached.
   */
  async lint (documentPath: string, text: string): Promise<DocumentLintRecord> {
    if (documentPath === '') {
      return await this.run(documentPath, text, '')
    }
    const revision = sha256Text(text)
    const inputs = await this.inputsKey(documentPath, text, new StampReader())
    const cached = this.entries.get(documentPath)
    if (cached !== undefined && cached.revision === revision && cached.inputs === inputs) {
      return cached
    }
    return await this.runOnce(documentPath, text, revision, inputs)
  }

  /**
   * The cached result for each document and whether it is current. Every
   * document without a current result is queued for the background linter;
   * nothing here waits for Flowmark.
   */
  async lookup (sources: DocumentLintSource[]): Promise<DocumentLintLookup[]> {
    const stamps = new StampReader()
    return await Promise.all(sources.map(async source => {
      const record = this.entries.get(source.path)
      const current = record !== undefined &&
        record.revision === sha256Text(source.text) &&
        record.inputs === await this.inputsKey(source.path, source.text, stamps)
      if (!current) {
        this.enqueue(source.path)
      }
      return { record, current }
    }))
  }

  private async runOnce (
    documentPath: string,
    text: string,
    revision: string,
    inputs: string
  ): Promise<DocumentLintRecord> {
    const flightKey = `${documentPath}\0${revision}\0${inputs}`
    let pending = this.inFlight.get(flightKey)
    if (pending === undefined) {
      pending = this.run(documentPath, text, inputs).finally(() => {
        this.inFlight.delete(flightKey)
      })
      this.inFlight.set(flightKey, pending)
    }
    return await pending
  }

  private async run (documentPath: string, text: string, inputs: string): Promise<DocumentLintRecord> {
    const config = this.deps.config.get()
    const context = await createDocumentLintContext({
      homeDirectory: this.deps.homeDirectory,
      env: this.deps.env,
      referenceState: this.deps.references?.getSnapshot(),
      wikilinks: this.deps.links?.index,
      tikzRenderConfig: this.tikzRenderConfig(),
      flowmarkLintTimeoutMs: config.editor.lint.flowmark.timeoutMs
    })
    const authority = await this.authority(documentPath)
    const outcome = await lintDocumentText(text, documentPath, context, authority)
    const record: DocumentLintRecord = {
      revision: sha256Text(text),
      inputs,
      lintedAt: new Date().toISOString(),
      diagnostics: outcome.diagnostics,
      complete: outcome.complete
    }
    // A Flowmark failure (a timeout, a missing install) is not a result of
    // the document; the next lint must try again.
    if (outcome.complete && documentPath !== '' && this.flowmarkIdentity !== undefined) {
      this.entries.set(documentPath, record)
      this.schedulePersist()
    }
    return record
  }

  private tikzRenderConfig (): ReturnType<typeof resolveTikzRenderConfig> {
    const config = this.deps.config.get()
    return resolveTikzRenderConfig(
      config.tikz.dataDir,
      config.tikz.figuresDir,
      this.deps.homeDirectory,
      this.deps.userDataDirectory,
      this.deps.env
    )
  }

  private async authority (documentPath: string): Promise<{ bibliographies?: string[], projectRoots?: string[] }> {
    const mainLibrary = this.deps.config.get().export.cslLibrary
    if (documentPath === '') {
      // An unsaved buffer cites from the main library, as citeproc renders it.
      return { bibliographies: mainLibrary === '' ? [] : [mainLibrary] }
    }
    if (this.deps.fsal === undefined) {
      // Without the file system layer there is no workspace to resolve a
      // bibliography from; Flowmark then reads the document's own metadata.
      return {}
    }
    return await documentLintAuthority(this.deps.fsal, mainLibrary, documentPath)
  }

  private async inputsKey (documentPath: string, text: string, stamps: StampReader): Promise<string> {
    const macroRoot = path.join(this.deps.homeDirectory, '.pandoc', 'styles', 'macros')
    const mathJaxMacros = path.join(this.deps.homeDirectory, '.pandoc', 'templates', 'css', 'mathjax-macros.json')
    const authority = await this.authority(documentPath)
    const referenceState = this.deps.references?.getSnapshot()
    return digest({
      build: this.deps.buildIdentity,
      flowmark: this.flowmarkIdentity,
      macros: [ ...await stamps.tree(macroRoot), await stamps.stamp(mathJaxMacros) ],
      tikz: tikzTemplateDependencyHash(this.tikzRenderConfig().templatePath),
      texinputs: this.deps.env.TEXINPUTS ?? null,
      definitions: referenceState === undefined ? null : digest(otherDefinitionSites(referenceState, documentPath)),
      wikilinks: this.deps.links === undefined ? null : digest(wikilinkResolutions(text, documentPath, this.deps.links.index)),
      bibliographies: authority.bibliographies === undefined
        ? null
        : await Promise.all(authority.bibliographies.map(async file => await stamps.stamp(file))),
      projectRoots: authority.projectRoots ?? null,
      flowmarkConfig: await stamps.flowmarkConfig(documentPath)
    })
  }

  private async refreshFlowmarkIdentity (): Promise<void> {
    try {
      this.flowmarkIdentity = await flowmarkInstallIdentity()
    } catch (error) {
      // Without an identity no result can be keyed; lints still run and
      // report the Flowmark failure themselves.
      this.flowmarkIdentity = undefined
      this.deps.log.error('[Document Lint] Results are not cached: the installed Flowmark is unknown', error)
    }
  }

  private scheduleReconcile (): void {
    if (this.stopped) {
      return
    }
    clearTimeout(this.reconcileTimer)
    this.reconcileTimer = setTimeout(() => {
      this.reconcile().catch(error => {
        this.deps.log.error('[Document Lint] Could not reconcile the workspace lint cache', error)
      })
    }, RECONCILE_DEBOUNCE_MS)
  }

  /** Queue every workspace Markdown document without a current result. */
  private async reconcile (): Promise<void> {
    if (this.deps.fsal === undefined || this.flowmarkIdentity === undefined) {
      return
    }
    const paths = await this.workspaceDocuments()
    const known = new Set(paths)
    for (const entryPath of [...this.entries.keys()]) {
      if (!known.has(entryPath) && this.deps.buffers.readMarkdownBufferContent(entryPath) === undefined) {
        this.entries.delete(entryPath)
        this.schedulePersist()
      }
    }
    const sources = await Promise.all(paths.map(async documentPath => ({
      path: documentPath,
      text: await this.currentText(documentPath)
    })))
    await this.lookup(sources)
  }

  /** Every Markdown document of the open workspaces. */
  async workspaceDocuments (): Promise<string[]> {
    if (this.deps.fsal === undefined) {
      throw new Error('[Document Lint] The workspace documents need the FSAL')
    }
    return (await this.deps.fsal.getAllLoadedDescriptors())
      .filter(descriptor => descriptor.type === 'file' && hasMarkdownExt(descriptor.path))
      .map(descriptor => descriptor.path)
  }

  /**
   * The machine-applicable fixes of each document, planned on its current
   * text. Each document is linted through the cache, WORKER_COUNT at a time,
   * as one long-running task.
   */
  async planFixes (documentPaths: string[]): Promise<FixAllPlan> {
    const task = this.deps.lrt?.registerTask(trans('Finding fixes'), 'Flowmark', undefined, false)
    const plan: FixAllPlan = { documents: [], documentsChecked: documentPaths.length, unlinted: [] }
    let next = 0
    let done = 0
    const worker = async (): Promise<void> => {
      while (next < documentPaths.length) {
        const documentPath = documentPaths[next]
        next += 1
        const text = await this.currentText(documentPath)
        const record = await this.lint(documentPath, text)
        if (!record.complete) {
          plan.unlinted.push(documentPath)
        } else {
          const edits = fixEdits(record.diagnostics)
          if (edits.length > 0) {
            plan.documents.push({ documentPath, sourceHash: hashDocumentSource(text), edits })
          }
        }
        done += 1
        task?.update({
          info: trans('%s of %s documents', done, documentPaths.length),
          percentage: done / documentPaths.length
        })
      }
    }
    try {
      await Promise.all(Array.from({ length: WORKER_COUNT }, worker))
    } catch (error) {
      if (task !== undefined) {
        this.deps.lrt?.settleTask(task, error instanceof Error ? error : new Error(String(error)))
      }
      throw error
    }
    if (task !== undefined) {
      this.deps.lrt?.settleTask(task)
    }
    plan.documents.sort((a, b) => a.documentPath.localeCompare(b.documentPath))
    plan.unlinted.sort()
    return plan
  }

  private async currentText (documentPath: string): Promise<string> {
    return this.deps.buffers.readMarkdownBufferContent(documentPath) ??
      await readFile(documentPath, 'utf8')
  }

  private enqueue (documentPath: string): void {
    if (this.stopped || this.flowmarkIdentity === undefined) {
      return
    }
    if (!this.queue.has(documentPath)) {
      this.queue.add(documentPath)
      this.countQueued()
    }
    while (this.activeWorkers < WORKER_COUNT && this.queue.size > 0) {
      this.activeWorkers += 1
      void this.work()
    }
  }

  private async work (): Promise<void> {
    for (const documentPath of this.queue) {
      if (this.stopped) {
        break
      }
      this.queue.delete(documentPath)
      try {
        await this.lint(documentPath, await this.currentText(documentPath))
      } catch (error) {
        this.deps.log.error(`[Document Lint] Could not lint ${documentPath}`, error)
        if (this.batch !== undefined) {
          this.batch.failed += 1
        }
      }
      if (this.batch !== undefined) {
        this.batch.done += 1
        this.showProgress(this.batch)
      }
    }
    this.activeWorkers -= 1
    if (this.activeWorkers === 0 && this.queue.size === 0) {
      this.settleBatch()
    }
  }

  private countQueued (): void {
    if (this.deps.lrt === undefined) {
      return
    }
    if (this.batch === undefined) {
      const task = this.deps.lrt.registerTask(trans('Linting workspace documents'), undefined, undefined, false)
      this.batch = { task, total: 0, done: 0, failed: 0 }
    }
    this.batch.total += 1
    this.showProgress(this.batch)
  }

  private showProgress (batch: { task: LongRunningTask, total: number, done: number }): void {
    batch.task.update({
      info: trans('%s of %s documents', batch.done, batch.total),
      percentage: batch.done / batch.total
    })
  }

  private settleBatch (): void {
    const batch = this.batch
    if (batch === undefined || this.deps.lrt === undefined) {
      return
    }
    this.batch = undefined
    this.deps.lrt.settleTask(
      batch.task,
      batch.failed === 0 ? undefined : new Error(trans('%s documents could not be linted; the log names each one', batch.failed))
    )
  }

  private async loadCache (): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.cachePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.deps.log.warning(`[Document Lint] Discarding the unreadable lint cache ${this.cachePath}`, error)
      return
    }
    const entries = (parsed as Partial<CacheFile> | null)?.entries
    if (typeof entries !== 'object' || entries === null) {
      this.deps.log.warning(`[Document Lint] Discarding the malformed lint cache ${this.cachePath}`)
      return
    }
    for (const [ documentPath, record ] of Object.entries(entries)) {
      if (isRecord(record)) {
        this.entries.set(documentPath, record)
      }
    }
  }

  private schedulePersist (): void {
    clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persist().catch(error => {
        this.deps.log.error('[Document Lint] Could not write the lint cache', error)
      })
    }, PERSIST_DEBOUNCE_MS)
  }

  private async persist (): Promise<void> {
    const file: CacheFile = { entries: Object.fromEntries(this.entries) }
    const temporary = `${this.cachePath}.tmp`
    await writeFile(temporary, JSON.stringify(file), 'utf8')
    await rename(temporary, this.cachePath)
  }
}
