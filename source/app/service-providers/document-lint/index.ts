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
 *                  the Flowmark run (the installed Flowmark, the vocabulary that the app sends, the
 *                  reference resolutions that Flowmark receives for the
 *                  document, the macro sources, the TikZ template graph, the
 *                  document's bibliographies and project roots, and the
 *                  Flowmark config files above it). Input files enter the key
 *                  by their content, never by their modification time. A lint whose key matches
 *                  is answered from the cache without running Flowmark.
 *
 *                  The documents of one pass (a reconcile, a fix plan) share
 *                  one LintPass, which reads each shared input once. The
 *                  work of a pass for one document therefore does not grow
 *                  with the number of documents.
 *
 *                  A background queue keeps the workspace current: at boot,
 *                  after a file system change, after a Flowmark update and
 *                  when a reader finds a stale entry, it re-lints each
 *                  document whose key no longer matches. The cache persists
 *                  in userData, so a restart keeps every result whose inputs
 *                  have not changed. While the queue runs, it is one
 *                  long-running task with its progress.
 *
 *                  A run that gave no result (a Flowmark process that
 *                  failed, a run that stopped) is no result of the document.
 *                  The provider keeps its cause for the session. A reader
 *                  gets the cause, and the queue does not run the same text
 *                  with the same inputs again until the author asks for it.
 *
 * END HEADER
 */

import { hashDocumentSource } from "@common/pandoc-util/extract-references";
import { hasMarkdownExt } from "@common/util/file-extention-checks";
import isErrnoException from "@common/util/is-errno-exception";
import { isAtOrInsideRoot } from "@common/util/renderer-path-polyfill";
import { sha256Text } from "@common/util/sha256";
import type { WikilinkIndex, WikilinkReading } from "@common/util/wikilink-resolution";
import type { FixAllEdit, FixAllPlan } from "@dts/common/fix-all";
import type { FlowmarkLintFailureKind } from "@dts/common/flowmark-lint";
import type { DirDescriptor } from "@dts/common/fsal";
import type {
  ApplyProblemFixRequest,
  ListProblemsRequest,
  ProblemDocument,
  UnlintedDocument,
  WorkspaceProblems,
} from "@dts/common/problems";
import type { TexCommandVocabulary } from "@dts/common/tex-vocabulary";
import { tikzTemplateDependencyHash } from "@dzack/tikz-render/tikz-render";
import type { ConfigOptions } from "@providers/config/get-config-template";
import type FSAL from "@providers/fsal";
import type { FSALEventPayload } from "@providers/fsal";
import type LogProvider from "@providers/log";
import type LongRunningTaskProvider from "@providers/long-running-tasks";
import type { LongRunningTask } from "@providers/long-running-tasks/task";
import type { WorkspaceReferenceState } from "@providers/references/reference-index";
import { createHash } from "crypto";
import { readdir, readFile, stat } from "fs/promises";
import { availableParallelism } from "os";
import path from "path";
import { trans } from "source/common/i18n-main";
import writeFileAtomic from "write-file-atomic";
import { documentLintAuthority } from "../../util/document-bibliographies";
import {
  createDocumentLintContext,
  type DocumentLintDiagnostic,
  type DocumentLintSharedContext,
  lintDocumentText,
} from "../../util/document-lint";
import {
  FLOWMARK_HOST_VOCABULARY,
  type FlowmarkReferenceContext,
  flowmarkReferenceContext,
  type WorkspaceDefinitions,
  wikilinkResolutions,
  workspaceDefinitions,
} from "../../util/flowmark-lint-context";
import { flowmarkInstallIdentity } from "../../util/flowmark-runtime";
import { readTexCommandVocabulary } from "../../util/flowmark-tex-vocabulary";
import { resolveTikzRenderConfig } from "../../util/resolve-tikz-render-config";
import { systemErrorCause } from "../../util/system-error-cause";
import { workspaceLintRows } from "../../util/workspace-lint-results";
import ProviderContract from "../provider-contract";

/** One document's lint result and the key it was computed under. */
export interface DocumentLintRecord {
  /** sha256 of the linted text: the document revision the diagnostics are for. */
  revision: string;
  /** Digest of every other input to the Flowmark run. */
  inputs: string;
  /** ISO 8601 time the Flowmark run finished. */
  lintedAt: string;
  diagnostics: DocumentLintDiagnostic[];
  /** False when Flowmark itself failed; such a record is never cached. */
  complete: boolean;
}

/** Why a run of a document gave no result. */
export interface DocumentLintFailure {
  /**
   * How the Flowmark process failed; `lint-error` for a run that stopped
   * outside that process; `unreadable` for a document whose file gave no
   * text, so that no run started.
   */
  kind: FlowmarkLintFailureKind | "lint-error" | "unreadable";
  message: string;
  /** ISO 8601 time the run ended. */
  failedAt: string;
}

export interface DocumentLintLookup {
  record?: DocumentLintRecord;
  /** True when the record's key matches the document's current text and inputs. */
  current: boolean;
  /** Present when the last run of this text with these inputs gave no result. */
  failure?: DocumentLintFailure;
}

/** A run that gave no result, with the key that it ran under. */
interface FailedRun extends DocumentLintFailure {
  revision: string;
  /** Absent for a run that stopped before its inputs were known. */
  inputs?: string;
}

/**
 * A document's current text, as the document authority or the disk has it,
 * or the cause when the file of the document gave no text.
 */
export type DocumentLintSource =
  | { path: string; text: string }
  | { path: string; unreadable: string };

export interface DocumentLintDependencies {
  log: LogProvider;
  config: {
    get: () => {
      export: { cslLibrary: string };
      tikz: Pick<ConfigOptions["tikz"], "dataDir" | "figuresDir">;
      zkn: Pick<ConfigOptions["zkn"], "linkFormat">;
      editor: {
        lint: { flowmark: ConfigOptions["editor"]["lint"]["flowmark"] };
      };
    };
  };
  /** Open buffers win over the disk. */
  buffers: {
    readMarkdownBufferContent: (filePath: string) => string | undefined;
    /** The time (epoch milliseconds) of the last update that an editor sent; 0 for none. */
    lastEditorInputAt: () => number;
  };
  references?: { getSnapshot: () => WorkspaceReferenceState };
  /** The workspace's wikilink index, which resolves the document's wikilinks. */
  links?: { index: WikilinkIndex };
  fsal?: Pick<FSAL, "getAnyDirectoryDescriptor" | "getAllLoadedDescriptors" | "on" | "off">;
  /** Shows the background queue in the status bar. */
  lrt?: Pick<LongRunningTaskProvider, "registerTask" | "settleTask">;
  homeDirectory: string;
  env: NodeJS.ProcessEnv;
  userDataDirectory: string;
  onDrain?: () => void;
}

interface CacheFile {
  entries: Record<string, DocumentLintRecord>;
}

const CACHE_FILE = "document-lint-cache.json";
// A change arrives as a burst of file system events; one reconcile follows it.
const RECONCILE_DEBOUNCE_MS = 1_000;
const PERSIST_DEBOUNCE_MS = 2_000;
// The background queue starts no Flowmark run until the editors had no input for this long.
const INPUT_IDLE_MS = 1_000;
// Each Flowmark run is one single-threaded Python process.
const WORKER_COUNT = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
// flowmark/config.py searches each directory upward for these names.
const FLOWMARK_CONFIG_NAMES = [".flowmark.toml", "flowmark.toml", "pyproject.toml"];

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * The fixes of one pass: every diagnostic's `fix` in source order, skipping
 * one that overlaps a fix already taken. A skipped fix remains a finding for
 * the next run, as in ESLint's SourceCodeFixer (eslint/lib/linter).
 */
export function fixEdits(diagnostics: readonly DocumentLintDiagnostic[]): FixAllEdit[] {
  const edits: FixAllEdit[] = [];
  let cursor = 0;
  const fixable = diagnostics
    .filter((diagnostic) => diagnostic.fix !== undefined)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  for (const diagnostic of fixable) {
    if (diagnostic.fix === undefined || diagnostic.from < cursor) {
      continue;
    }
    edits.push({
      from: diagnostic.from,
      to: diagnostic.to,
      insert: diagnostic.fix.replacement,
      rule: diagnostic.rule,
    });
    cursor = diagnostic.to;
  }
  return edits;
}

function isRecord(value: unknown): value is DocumentLintRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<DocumentLintRecord>;
  return (
    typeof candidate.revision === "string" &&
    typeof candidate.inputs === "string" &&
    typeof candidate.lintedAt === "string" &&
    Array.isArray(candidate.diagnostics) &&
    candidate.complete === true
  );
}

type DirectoryReader = Pick<FSAL, "getAnyDirectoryDescriptor">;

/** The inputs of a Flowmark run that belong to one document. */
interface DocumentInputs {
  bibliographies?: string[];
  projectRoots?: string[];
  references?: FlowmarkReferenceContext;
}

/**
 * The content hash of each input file. A file is read and hashed again only
 * when its size or modification time moved, as git's index skips rehashing
 * a file whose stat data is unchanged (git/read-cache.c, ie_match_stat). The
 * stat data never enters a cache key: a file written again with the same
 * bytes keeps its hash.
 */
class ContentHashes {
  private readonly known = new Map<string, { mtimeMs: number; size: number; hash: string }>();

  async of(filePath: string): Promise<string> {
    const info = await stat(filePath);
    const known = this.known.get(filePath);
    if (known !== undefined && known.mtimeMs === info.mtimeMs && known.size === info.size) {
      return known.hash;
    }
    const hash = createHash("sha256")
      .update(await readFile(filePath))
      .digest("hex");
    this.known.set(filePath, { mtimeMs: info.mtimeMs, size: info.size, hash });
    return hash;
  }
}

/**
 * The inputs that the documents of one pass share. Each is read once, when
 * the first document needs it.
 */
class LintPass {
  constructor(private readonly contentHashes: ContentHashes) {}

  private readonly stamps = new Map<string, Promise<string>>();
  private readonly trees = new Map<string, Promise<string[]>>();
  private readonly directories = new Map<string, Promise<DirDescriptor>>();
  private tikzHash: string | undefined;
  private definitions: WorkspaceDefinitions | undefined;

  /** The file system layer, with one read of each directory descriptor. */
  directoryReader(fsal: DirectoryReader): DirectoryReader {
    return {
      getAnyDirectoryDescriptor: async (absPath) => {
        let pending = this.directories.get(absPath);
        if (pending === undefined) {
          pending = fsal.getAnyDirectoryDescriptor(absPath);
          this.directories.set(absPath, pending);
        }
        return await pending;
      },
    };
  }

  tikzTemplate(templatePath: string): string {
    this.tikzHash ??= tikzTemplateDependencyHash(templatePath);
    return this.tikzHash;
  }

  workspaceDefinitions(references: {
    getSnapshot: () => WorkspaceReferenceState;
  }): WorkspaceDefinitions {
    this.definitions ??= workspaceDefinitions(references.getSnapshot());
    return this.definitions;
  }

  async stamp(filePath: string): Promise<string> {
    let pending = this.stamps.get(filePath);
    if (pending === undefined) {
      pending = this.contentHashes.of(filePath).then(
        (hash) => `${filePath}\0${hash}`,
        () => `${filePath}\0absent`,
      );
      this.stamps.set(filePath, pending);
    }
    return await pending;
  }

  async tree(root: string): Promise<string[]> {
    let pending = this.trees.get(root);
    if (pending === undefined) {
      pending = this.readTree(root);
      this.trees.set(root, pending);
    }
    return await pending;
  }

  private async readTree(root: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(root, { recursive: true, withFileTypes: true });
    } catch {
      return [await this.stamp(root)];
    }
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(entry.parentPath, entry.name))
      .sort();
    return await Promise.all(files.map(async (file) => await this.stamp(file)));
  }

  async flowmarkConfig(documentPath: string): Promise<string[]> {
    const candidates: string[] = [];
    let directory = path.dirname(documentPath);
    for (;;) {
      candidates.push(...FLOWMARK_CONFIG_NAMES.map((name) => path.join(directory, name)));
      const parent = path.dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }
    const stamps = await Promise.all(candidates.map(async (file) => await this.stamp(file)));
    return stamps.filter((stamp) => !stamp.endsWith("\0absent"));
  }
}

export default class DocumentLintProvider extends ProviderContract {
  private readonly entries = new Map<string, DocumentLintRecord>();
  /** The last run of each document that gave no result. Not persisted. */
  private readonly failures = new Map<string, FailedRun>();
  private readonly contentHashes = new ContentHashes();
  /** Each queued document, with the pass that found it without a current result. */
  private readonly queue = new Map<string, LintPass>();
  private readonly inFlight = new Map<string, Promise<DocumentLintRecord>>();
  private activeWorkers = 0;
  /** Ends the wait of each worker that waits for the editors to be idle. */
  private readonly idleWaits = new Set<() => void>();
  /** The status bar task of the running queue, from its first document until it drains. */
  private batch: { task: LongRunningTask; total: number; done: number; failed: number } | undefined;
  private flowmarkIdentity: string | undefined;
  /** Why the installed Flowmark is unknown; then the queue lints no document. */
  private flowmarkIdentityFailure: Error | undefined;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private persistTimer: NodeJS.Timeout | undefined;
  private readonly backgroundTasks = new Set<Promise<void>>();
  private backgroundFailure: Error | undefined;
  private booted = false;
  private stopped = false;

  private readonly onFsalEvents = (events: FSALEventPayload[]): void => {
    for (const payload of events) {
      if (payload.event === "unlink") {
        this.failures.delete(payload.path);
        if (this.entries.delete(payload.path)) {
          this.schedulePersist();
        }
      } else if (
        (payload.event === "add" || payload.event === "change") &&
        hasMarkdownExt(payload.descriptor.path)
      ) {
        this.scheduleReconcile();
      }
    }
  };

  constructor(private readonly deps: DocumentLintDependencies) {
    super();
  }

  private get cachePath(): string {
    return path.join(this.deps.userDataDirectory, CACHE_FILE);
  }

  async boot(): Promise<void> {
    await this.loadCache();
    await this.refreshFlowmarkIdentity();
    this.deps.fsal?.on("fsal-events", this.onFsalEvents);
    this.booted = true;
    this.scheduleReconcile();
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const endWait of [...this.idleWaits]) {
      endWait();
    }
    this.deps.fsal?.off("fsal-events", this.onFsalEvents);
    clearTimeout(this.reconcileTimer);
    clearTimeout(this.persistTimer);
    await Promise.all(this.backgroundTasks);
    await this.persist();
    this.assertBackgroundHealthy();
  }

  /** Call after the Flowmark install changed: every result it produced is outdated. */
  async flowmarkUpdated(): Promise<void> {
    // Before boot there is nothing to invalidate; boot reads the identity.
    if (!this.booted) {
      return;
    }
    await this.refreshFlowmarkIdentity();
    // Another Flowmark can lint what the last one could not.
    this.failures.clear();
    this.scheduleReconcile();
  }

  /**
   * The author asks for the lint again. Each cause of a missing result is
   * forgotten: the failed runs, an unknown Flowmark install and a failure of
   * the background work. The results are written again, and the next
   * reader queues each document without a current result.
   */
  async retry(): Promise<void> {
    this.failures.clear();
    this.backgroundFailure = undefined;
    if (this.flowmarkIdentity === undefined) {
      await this.refreshFlowmarkIdentity();
    }
    this.schedulePersist();
    this.scheduleReconcile();
  }

  /**
   * Lint a document, answering from the cache when its key matches. A
   * document without a path (an unsaved buffer) is linted and not cached.
   */
  async lint(documentPath: string, text: string): Promise<DocumentLintRecord> {
    this.assertBackgroundHealthy();
    return await this.lintIn(new LintPass(this.contentHashes), documentPath, text);
  }

  private async lintIn(
    pass: LintPass,
    documentPath: string,
    text: string,
  ): Promise<DocumentLintRecord> {
    const document = await this.documentInputs(documentPath, text, pass);
    if (documentPath === "") {
      return await this.run(documentPath, text, document, "");
    }
    const revision = sha256Text(text);
    const inputs = await this.inputsKey(documentPath, text, document, pass);
    const cached = this.entries.get(documentPath);
    if (cached !== undefined && cached.revision === revision && cached.inputs === inputs) {
      return cached;
    }
    return await this.runOnce(documentPath, text, document, revision, inputs);
  }

  /**
   * The cached result for each document and whether it is current. Every
   * document without a current result is queued for the background linter;
   * nothing here waits for Flowmark.
   */
  async lookup(sources: DocumentLintSource[]): Promise<DocumentLintLookup[]> {
    this.assertBackgroundHealthy();
    const pass = new LintPass(this.contentHashes);
    return await Promise.all(
      sources.map(async (source) => {
        if ("unreadable" in source) {
          // No run can start, and the cause is that of this read: the next
          // reader reads the file again.
          return {
            current: false,
            failure: {
              kind: "unreadable" as const,
              message: source.unreadable,
              failedAt: new Date().toISOString(),
            },
          };
        }
        const record = this.entries.get(source.path);
        const failedRun = this.failures.get(source.path);
        const revision = sha256Text(source.text);
        const recordOfText = record !== undefined && record.revision === revision;
        const failureOfText = failedRun !== undefined && failedRun.revision === revision;
        // The inputs decide only for a result or a failure of this text.
        const inputs =
          recordOfText || (failureOfText && failedRun.inputs !== undefined)
            ? await this.inputsKey(
                source.path,
                source.text,
                await this.documentInputs(source.path, source.text, pass),
                pass,
              )
            : undefined;
        const current = recordOfText && record.inputs === inputs;
        const failed =
          failureOfText && (failedRun.inputs === undefined || failedRun.inputs === inputs);
        if (!current && !failed) {
          this.enqueue(source.path, pass);
        }
        if (!failed) {
          return { record, current };
        }
        return {
          record,
          current,
          failure: {
            kind: failedRun.kind,
            message: failedRun.message,
            failedAt: failedRun.failedAt,
          },
        };
      }),
    );
  }

  private async runOnce(
    documentPath: string,
    text: string,
    document: DocumentInputs,
    revision: string,
    inputs: string,
  ): Promise<DocumentLintRecord> {
    const flightKey = `${documentPath}\0${revision}\0${inputs}`;
    let pending = this.inFlight.get(flightKey);
    if (pending === undefined) {
      pending = this.run(documentPath, text, document, inputs).finally(() => {
        this.inFlight.delete(flightKey);
      });
      this.inFlight.set(flightKey, pending);
    }
    return await pending;
  }

  /**
   * The TeX vocabulary of the lint context, from which the editor completes
   * the commands that `tex/unknown-command` accepts.
   */
  async texCommandVocabulary(): Promise<TexCommandVocabulary> {
    return await readTexCommandVocabulary(await this.sharedContext());
  }

  private async sharedContext(): Promise<DocumentLintSharedContext> {
    return await createDocumentLintContext({
      homeDirectory: this.deps.homeDirectory,
      env: this.deps.env,
      wikilinks: this.wikilinkReading(),
      tikzRenderConfig: this.tikzRenderConfig(),
      flowmarkLintTimeoutMs: this.deps.config.get().editor.lint.flowmark.timeoutMs,
    });
  }

  private async run(
    documentPath: string,
    text: string,
    document: DocumentInputs,
    inputs: string,
  ): Promise<DocumentLintRecord> {
    const context = await this.sharedContext();
    const outcome = await lintDocumentText(text, documentPath, context, document);
    const record: DocumentLintRecord = {
      revision: sha256Text(text),
      inputs,
      lintedAt: new Date().toISOString(),
      diagnostics: outcome.diagnostics,
      complete: outcome.complete,
    };
    if (documentPath === "") {
      return record;
    }
    // A Flowmark failure (a timeout, a missing install) is not a result of
    // the document. The cause is kept, so a reader gets it and the queue
    // does not run this text with these inputs again.
    if (outcome.failure !== undefined) {
      this.failures.set(documentPath, {
        ...outcome.failure,
        failedAt: record.lintedAt,
        revision: record.revision,
        inputs,
      });
      return record;
    }
    this.failures.delete(documentPath);
    if (this.flowmarkIdentity !== undefined) {
      this.entries.set(documentPath, record);
      this.schedulePersist();
    }
    return record;
  }

  // The reading of the wikilinks of the workspace: its index and the link
  // format of the settings.
  private wikilinkReading(): WikilinkReading | undefined {
    if (this.deps.links === undefined) {
      return undefined;
    }
    return { index: this.deps.links.index, linkFormat: this.deps.config.get().zkn.linkFormat };
  }

  private tikzRenderConfig(): ReturnType<typeof resolveTikzRenderConfig> {
    const config = this.deps.config.get();
    return resolveTikzRenderConfig(
      config.tikz.dataDir,
      config.tikz.figuresDir,
      this.deps.homeDirectory,
      this.deps.userDataDirectory,
      this.deps.env,
    );
  }

  private async documentInputs(
    documentPath: string,
    text: string,
    pass: LintPass,
  ): Promise<DocumentInputs> {
    const references =
      this.deps.references === undefined
        ? undefined
        : flowmarkReferenceContext(
            documentPath,
            text,
            pass.workspaceDefinitions(this.deps.references),
          );
    return { ...(await this.authority(documentPath, text, pass)), references };
  }

  private async authority(
    documentPath: string,
    text: string,
    pass: LintPass,
  ): Promise<{ bibliographies?: string[]; projectRoots?: string[] }> {
    const mainLibrary = this.deps.config.get().export.cslLibrary;
    if (documentPath === "") {
      // An unsaved buffer cites from the main library, as citeproc renders it.
      return { bibliographies: mainLibrary === "" ? [] : [mainLibrary] };
    }
    if (this.deps.fsal === undefined) {
      // Without the file system layer there is no workspace to resolve a
      // bibliography from; Flowmark then reads the document's own metadata.
      return {};
    }
    return await documentLintAuthority(
      pass.directoryReader(this.deps.fsal),
      mainLibrary,
      documentPath,
      text,
    );
  }

  private async inputsKey(
    documentPath: string,
    text: string,
    document: DocumentInputs,
    pass: LintPass,
  ): Promise<string> {
    const wikilinks = this.wikilinkReading();
    const macroRoot = path.join(this.deps.homeDirectory, ".pandoc", "styles", "macros");
    const mathJaxMacros = path.join(
      this.deps.homeDirectory,
      ".pandoc",
      "templates",
      "css",
      "mathjax-macros.json",
    );
    return digest({
      vocabulary: FLOWMARK_HOST_VOCABULARY,
      flowmark: this.flowmarkIdentity,
      macros: [...(await pass.tree(macroRoot)), await pass.stamp(mathJaxMacros)],
      tikz: pass.tikzTemplate(this.tikzRenderConfig().templatePath),
      texinputs: this.deps.env.TEXINPUTS ?? null,
      // The revision covers the document's own definitions and references.
      references: document.references === undefined ? null : document.references.resolutions,
      wikilinks:
        wikilinks === undefined ? null : digest(wikilinkResolutions(text, documentPath, wikilinks)),
      bibliographies:
        document.bibliographies === undefined
          ? null
          : await Promise.all(document.bibliographies.map(async (file) => await pass.stamp(file))),
      projectRoots: document.projectRoots === undefined ? null : document.projectRoots,
      flowmarkConfig: await pass.flowmarkConfig(documentPath),
    });
  }

  private async refreshFlowmarkIdentity(): Promise<void> {
    await flowmarkInstallIdentity().then(
      (identity) => {
        this.flowmarkIdentity = identity;
        this.flowmarkIdentityFailure = undefined;
      },
      (error: unknown) => {
        // Without an identity no result can be keyed; lints still run and
        // report the Flowmark failure themselves.
        this.flowmarkIdentity = undefined;
        this.flowmarkIdentityFailure = error instanceof Error ? error : new Error(String(error));
        this.deps.log.error(
          "[Document Lint] Results are not cached: the installed Flowmark is unknown",
          error,
        );
      },
    );
  }

  private scheduleReconcile(): void {
    if (this.stopped) {
      return;
    }
    clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => {
      this.startBackground(this.reconcile(), "Reconcile workspace lint cache");
    }, RECONCILE_DEBOUNCE_MS);
  }

  private assertBackgroundHealthy(): void {
    if (this.backgroundFailure !== undefined) {
      throw this.backgroundFailure;
    }
  }

  private startBackground(operation: Promise<void>, title: string): void {
    const task = operation
      .catch((error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.backgroundFailure = failure;
        this.deps.log.error(`[Document Lint] ${title} failed`, failure);
        // An open reader asks again and gets the failure.
        this.deps.onDrain?.();
        if (this.deps.lrt !== undefined) {
          const status = this.deps.lrt.registerTask(trans(title), "Flowmark", undefined, false);
          this.deps.lrt.settleTask(status, failure);
        }
      })
      .finally(() => {
        this.backgroundTasks.delete(task);
      });
    this.backgroundTasks.add(task);
  }

  /** Queue every workspace Markdown document without a current result. */
  private async reconcile(): Promise<void> {
    if (this.deps.fsal === undefined || this.flowmarkIdentity === undefined) {
      return;
    }
    const paths = await this.workspaceDocuments();
    const known = new Set(paths);
    for (const entryPath of [...this.entries.keys()]) {
      if (
        !known.has(entryPath) &&
        this.deps.buffers.readMarkdownBufferContent(entryPath) === undefined
      ) {
        this.entries.delete(entryPath);
        this.schedulePersist();
      }
    }
    const sources = await Promise.all(
      paths.map(async (documentPath) => await this.source(documentPath)),
    );
    await this.lookup(sources);
  }

  /** Every Markdown document of the open workspaces. */
  async workspaceDocuments(): Promise<string[]> {
    if (this.deps.fsal === undefined) {
      throw new Error("[Document Lint] The workspace documents need the FSAL");
    }
    return (await this.deps.fsal.getAllLoadedDescriptors())
      .filter((descriptor) => descriptor.type === "file" && hasMarkdownExt(descriptor.path))
      .map((descriptor) => descriptor.path);
  }

  /** Why the background queue lints no document; null while it runs. */
  queueStopped(): string | null {
    return this.flowmarkIdentityFailure === undefined ? null : this.flowmarkIdentityFailure.message;
  }

  /** Answer the Problems view from cached records and queue outdated documents. */
  async workspaceProblems(request: ListProblemsRequest): Promise<WorkspaceProblems> {
    this.assertBackgroundHealthy();
    const allPaths = await this.workspaceDocuments();
    const workspacePath = request.workspacePath;
    const paths =
      request.scope === "all"
        ? allPaths
        : workspacePath === undefined
          ? []
          : allPaths.filter((filePath) => isAtOrInsideRoot(filePath, workspacePath));
    const sources = await Promise.all(paths.map(async (filePath) => await this.source(filePath)));
    const lookups = await workspaceLintRows(this, sources);
    const documents: ProblemDocument[] = [];
    const pendingPaths: string[] = [];
    const failed: UnlintedDocument[] = [];
    lookups.forEach((lookup, index) => {
      const filePath = paths[index];
      const source = sources[index];
      const record = lookup.record;
      if (lookup.failure !== undefined) {
        failed.push({
          path: filePath,
          name: path.basename(filePath),
          cause: lookup.failure.message,
        });
      }
      if (record === undefined || "unreadable" in source) {
        if (lookup.failure === undefined) {
          pendingPaths.push(filePath);
        }
        return;
      }
      if (record.diagnostics.length === 0) {
        return;
      }
      const counts = { error: 0, warning: 0, info: 0 };
      const diagnostics = record.diagnostics.map((diagnostic) => {
        counts[diagnostic.severity] += 1;
        return {
          severity: diagnostic.severity,
          rule: diagnostic.rule,
          source: diagnostic.source,
          message: diagnostic.message,
          line: diagnostic.line,
          column: diagnostic.column,
          from: diagnostic.from,
          to: diagnostic.to,
          fix: diagnostic.fix === undefined ? null : diagnostic.fix,
        };
      });
      documents.push({
        path: filePath,
        name: path.basename(filePath),
        state: lookup.current ? "current" : "stale",
        sourceHash: hashDocumentSource(source.text),
        diagnostics,
        counts,
      });
    });
    documents.sort((a, b) => a.path.localeCompare(b.path));
    pendingPaths.sort();
    failed.sort((a, b) => a.path.localeCompare(b.path));
    return {
      documents,
      pendingPaths,
      failed,
      queueStopped: this.queueStopped(),
      documentCount: paths.length,
      queueActive: this.activeWorkers > 0 || this.queue.size > 0,
    };
  }

  /** A single-fix request must still name a current Flowmark machine edit. */
  async hasCurrentFix(request: ApplyProblemFixRequest): Promise<boolean> {
    this.assertBackgroundHealthy();
    if (!(await this.workspaceDocuments()).includes(request.documentPath)) {
      return false;
    }
    const text = await this.currentText(request.documentPath);
    if (hashDocumentSource(text) !== request.sourceHash) {
      return false;
    }
    const [lookup] = await this.lookup([{ path: request.documentPath, text }]);
    if (!lookup.current || lookup.record === undefined) {
      return false;
    }
    return lookup.record.diagnostics.some(
      (diagnostic) =>
        diagnostic.from === request.from &&
        diagnostic.to === request.to &&
        diagnostic.fix?.replacement === request.replacement,
    );
  }

  /**
   * The machine-applicable fixes of each document, planned on its current
   * text. Each document is linted through the cache, WORKER_COUNT at a time,
   * as one long-running task.
   */
  async planFixes(documentPaths: string[]): Promise<FixAllPlan> {
    this.assertBackgroundHealthy();
    const task = this.deps.lrt?.registerTask(trans("Finding fixes"), "Flowmark", undefined, false);
    const plan: FixAllPlan = {
      documents: [],
      documentsChecked: documentPaths.length,
      unlinted: [],
    };
    const pass = new LintPass(this.contentHashes);
    let next = 0;
    let done = 0;
    const worker = async (): Promise<void> => {
      while (next < documentPaths.length) {
        const documentPath = documentPaths[next];
        next += 1;
        const source = await this.source(documentPath);
        if ("unreadable" in source) {
          this.deps.log.error(
            `[Document Lint] Could not read ${documentPath}: ${source.unreadable}`,
          );
          plan.unlinted.push(documentPath);
          done += 1;
          continue;
        }
        const text = source.text;
        const record = await this.lintIn(pass, documentPath, text);
        if (!record.complete) {
          plan.unlinted.push(documentPath);
        } else {
          const edits = fixEdits(record.diagnostics);
          if (edits.length > 0) {
            plan.documents.push({
              documentPath,
              sourceHash: hashDocumentSource(text),
              edits,
            });
          }
        }
        done += 1;
        task?.update({
          info: trans("%s of %s documents", done, documentPaths.length),
          percentage: done / documentPaths.length,
        });
      }
    };
    try {
      await Promise.all(Array.from({ length: WORKER_COUNT }, worker));
    } catch (error) {
      if (task !== undefined) {
        this.deps.lrt?.settleTask(task, error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }
    if (task !== undefined) {
      this.deps.lrt?.settleTask(task);
    }
    plan.documents.sort((a, b) => a.documentPath.localeCompare(b.documentPath));
    plan.unlinted.sort();
    return plan;
  }

  /**
   * The current text of a workspace document, or the cause when the
   * filesystem gives no text. One such document does not stop the answer
   * for the other documents of a workspace.
   */
  private async source(documentPath: string): Promise<DocumentLintSource> {
    return await this.currentText(documentPath).then(
      (text) => ({ path: documentPath, text }),
      (error: unknown) => {
        if (!isErrnoException(error)) {
          throw error;
        }
        return { path: documentPath, unreadable: error.message };
      },
    );
  }

  private async currentText(documentPath: string): Promise<string> {
    return (
      this.deps.buffers.readMarkdownBufferContent(documentPath) ??
      (await readFile(documentPath, "utf8"))
    );
  }

  private enqueue(documentPath: string, pass: LintPass): void {
    if (this.stopped || this.flowmarkIdentity === undefined) {
      return;
    }
    if (!this.queue.has(documentPath)) {
      this.countQueued();
    }
    // The newest pass has the newest inputs.
    this.queue.set(documentPath, pass);
    while (this.activeWorkers < WORKER_COUNT && this.queue.size > 0) {
      this.activeWorkers += 1;
      this.startBackground(this.work(), "Lint workspace documents");
    }
  }

  /**
   * Resolves when no editor had input for INPUT_IDLE_MS. A Flowmark run takes
   * processor time from the window, so the queue starts none while the author
   * types (#139). The TypeScript extension of VS Code delays its diagnostics
   * request in the same way while a buffer changes (typescript-language-features,
   * bufferSyncSupport.ts, `diagnosticDelayer`).
   */
  private async editorsIdle(): Promise<void> {
    for (;;) {
      const remaining = INPUT_IDLE_MS - (Date.now() - this.deps.buffers.lastEditorInputAt());
      if (remaining <= 0 || this.stopped) {
        return;
      }
      if (this.batch !== undefined) {
        this.batch.task.update({
          info: trans(
            "%s of %s documents; waiting for a pause in the editor",
            this.batch.done,
            this.batch.total,
          ),
          percentage: this.batch.done / this.batch.total,
        });
      }
      await new Promise<void>((resolve) => {
        const endWait = (): void => {
          clearTimeout(timer);
          this.idleWaits.delete(endWait);
          resolve();
        };
        const timer = setTimeout(endWait, remaining);
        this.idleWaits.add(endWait);
      });
      if (this.batch !== undefined) {
        this.showProgress(this.batch);
      }
    }
  }

  private async work(): Promise<void> {
    try {
      while (!this.stopped && this.queue.size > 0) {
        await this.editorsIdle();
        // Another worker can take a document during the wait, and a newer
        // pass can replace the pass of a queued document.
        const next = this.queue.entries().next();
        if (this.stopped || next.done === true) {
          break;
        }
        const [documentPath, pass] = next.value;
        this.queue.delete(documentPath);
        const linted = await this.lintQueued(pass, documentPath);
        if (!linted && this.batch !== undefined) {
          this.batch.failed += 1;
        }
        if (this.batch !== undefined) {
          this.batch.done += 1;
          this.showProgress(this.batch);
        }
      }
    } finally {
      this.activeWorkers -= 1;
      if (this.activeWorkers === 0 && this.queue.size === 0) {
        this.settleBatch();
        this.deps.onDrain?.();
      }
    }
  }

  /** Lints one document of the queue. Answers whether the run gave a result. */
  private async lintQueued(pass: LintPass, documentPath: string): Promise<boolean> {
    const text = await this.currentText(documentPath).catch((error: unknown) => {
      // The file went away after a reader queued it; the next reader has
      // the documents that are there.
      this.deps.log.error(`[Document Lint] Could not read ${documentPath}`, error);
      return undefined;
    });
    if (text === undefined) {
      return false;
    }
    return await this.lintIn(pass, documentPath, text).then(
      (record) => {
        if (!record.complete) {
          this.deps.log.error(
            `[Document Lint] Flowmark could not lint ${documentPath}`,
            this.failures.get(documentPath),
          );
        }
        return record.complete;
      },
      (error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.deps.log.error(`[Document Lint] Could not lint ${documentPath}`, failure);
        this.failures.set(documentPath, {
          kind: "lint-error",
          message: failure.message,
          failedAt: new Date().toISOString(),
          revision: sha256Text(text),
        });
        return false;
      },
    );
  }

  private countQueued(): void {
    if (this.deps.lrt === undefined) {
      return;
    }
    if (this.batch === undefined) {
      const task = this.deps.lrt.registerTask(
        trans("Linting workspace documents"),
        undefined,
        undefined,
        false,
      );
      this.batch = { task, total: 0, done: 0, failed: 0 };
    }
    this.batch.total += 1;
    this.showProgress(this.batch);
  }

  private showProgress(batch: { task: LongRunningTask; total: number; done: number }): void {
    batch.task.update({
      info: trans("%s of %s documents", batch.done, batch.total),
      percentage: batch.done / batch.total,
    });
  }

  private settleBatch(): void {
    const batch = this.batch;
    if (batch === undefined || this.deps.lrt === undefined) {
      return;
    }
    this.batch = undefined;
    this.deps.lrt.settleTask(
      batch.task,
      batch.failed === 0
        ? undefined
        : new Error(
            trans(
              "%s documents could not be linted; the Problems view names each one",
              batch.failed,
            ),
          ),
    );
  }

  private async loadCache(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.cachePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.deps.log.warning(
        `[Document Lint] Discarding the unreadable lint cache ${this.cachePath}`,
        error,
      );
      return;
    }
    const entries = (parsed as Partial<CacheFile> | null)?.entries;
    if (typeof entries !== "object" || entries === null) {
      this.deps.log.warning(
        `[Document Lint] Discarding the malformed lint cache ${this.cachePath}`,
      );
      return;
    }
    for (const [documentPath, record] of Object.entries(entries)) {
      if (isRecord(record)) {
        this.entries.set(documentPath, record);
      }
    }
  }

  private schedulePersist(): void {
    if (this.stopped) {
      return;
    }
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.startBackground(this.persist(), "Write the workspace lint cache");
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persist(): Promise<void> {
    const file: CacheFile = { entries: Object.fromEntries(this.entries) };
    await writeFileAtomic(this.cachePath, JSON.stringify(file), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        throw new Error(
          trans(
            "Could not write the lint results to %s: %s.",
            this.cachePath,
            systemErrorCause(error),
          ),
          { cause: error },
        );
      },
    );
  }
}
