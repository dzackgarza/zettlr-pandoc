/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        AgentDocumentQueries
 * CVM-Role:        Service
 * Maintainer:     D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Provides document and workspace projections for the Agent
 *                  API. It owns no document state and performs no HTTP work.
 *
 * END HEADER
 */

import { Text } from "@codemirror/state";
import { sha256Text } from "@common/util/sha256";
import type { WikilinkIndex } from "@common/util/wikilink-resolution";
import type {
  AnnotationListResponse,
  AnnotationResponse,
  DocumentSummary,
  EditorContext,
  EditorViewSummary,
  ReadDocumentResponse,
  ReadSide,
  SearchDocumentRequest,
  SearchDocumentResponse,
  ViewSummary,
  WorkspaceDirectoriesResponse,
  WorkspaceDirectoryEntry,
  WorkspaceDocumentEntry,
  WorkspaceEntryCreateRequest,
  WorkspaceEntryResponse,
  WorkspaceFileEntry,
} from "@dts/common/agent-api";
import type { AnnotationSet, TextAnnotation } from "@dts/common/annotation-domain";
import { DocumentType } from "@dts/common/documents";
import type DocumentManager from "@providers/documents";
import type {
  CollaborationApplicationService,
  ReviewQueryPort,
} from "@providers/documents/document-collaboration-application-service";
import { normalizeText, reviewReferenceText } from "@providers/documents/review-diff-store";
import type LogProvider from "@providers/log";
import fs from "fs";
import path from "path";
import makeSearchRegex from "source/common/util/make-search-regex";
import vm from "vm";

const SEARCH_CONTEXT_DEFAULT = 3;
export const SEARCH_DEADLINE_MS = 1000;
export const MAX_SEARCH_HITS = 1000;

export class SearchPatternError extends Error {
  constructor(cause?: unknown) {
    super("Invalid search pattern", { cause });
  }
}

export class SearchTimeoutError extends Error {
  constructor() {
    super("Search timed out");
  }
}

function collectSearchHits(
  lines: string[],
  searchRegex: RegExp,
  contextSize: number,
  maxHits: number,
): { hits: SearchDocumentResponse["hits"]; truncated: boolean } {
  const hits: SearchDocumentResponse["hits"] = [];
  let truncated = false;
  for (let i = 0; i < lines.length; i++) {
    searchRegex.lastIndex = 0;
    let match: RegExpExecArray | null = searchRegex.exec(lines[i]);
    while (match !== null) {
      const found = match.index;
      const hitLength = match[0].length;
      if (hitLength === 0) {
        searchRegex.lastIndex += 1;
        match = searchRegex.exec(lines[i]);
        continue;
      }
      if (hits.length >= maxHits) {
        truncated = true;
        return { hits, truncated };
      }
      hits.push({
        line: i + 1,
        column: found + 1,
        length: hitLength,
        contextBefore: lines.slice(Math.max(0, i - contextSize), i).join("\n"),
        contextAfter: lines.slice(i + 1, Math.min(lines.length, i + 1 + contextSize)).join("\n"),
      });
      if (searchRegex.lastIndex >= lines[i].length) {
        break;
      }
      match = searchRegex.exec(lines[i]);
    }
  }
  return { hits, truncated };
}

export interface AgentDocumentQueryHost {
  config: {
    get: () => { app: { openWorkspaces: string[] } };
  };
  links: { readonly index: WikilinkIndex };
  /**
   * The filesystem seam the workspace-entry operations need. Optional so a
   * host that only reads documents keeps compiling; a request that creates an
   * entry or lists directories answers PERSISTENCE_FAILED without it.
   */
  fsal?: {
    pathExists: (absPath: string) => Promise<boolean>;
    isDir: (absPath: string) => Promise<boolean>;
    readDirectoryRecursively: (directoryPath: string) => Promise<string[]>;
    createDir: (dirPath: string) => Promise<void>;
    createFile: (filePath: string, content: string) => Promise<void>;
  };
}

/** Why a workspace-entry creation was refused, mapped to a wire error code. */
export type WorkspaceEntryFailureCode =
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_OUTSIDE_SCOPE"
  | "WORKSPACE_ENTRY_EXISTS"
  | "INVALID_PARAMS"
  | "PERSISTENCE_FAILED";

export type WorkspaceEntryCreation =
  | { ok: true; entry: WorkspaceEntryResponse }
  | { ok: false; code: WorkspaceEntryFailureCode; message: string };

/**
 * Read-only annotation projections for transport providers. Annotation
 * mutation is a separate, narrower surface (DocumentManager.addAnnotationMessage)
 * — the only annotation write the agent HTTP API exposes (I3).
 *
 * `listCollaborationSidecars` is what closes the read contract: without it a
 * closed document's annotations — everything the UI workspace panel shows —
 * would be invisible to an agent, and the only mutation would 404 on an
 * annotation the listing never produced. Same enumeration the workspace
 * projection and `listReviewQueries` already serve detached reviews through.
 */
export type AnnotationQueryPort = Pick<
  CollaborationApplicationService,
  "getAnnotations" | "listCollaborationSidecars"
>;

/** One annotation read, located: which document it belongs to and where its
 * text lives — the live buffer of an open document, or the persisted working
 * text of a detached sidecar.
 */
interface LocatedAnnotation {
  documentId: string;
  annotation: TextAnnotation;
  annotationGeneration: number;
  workingText: string;
}

/** A document's working text, and the text its review started from. */
interface DocumentText {
  attached: boolean;
  working: string;
  reference: string;
  reviewGeneration: number;
}

/**
 * Converts a UTF-16 code-unit offset into a 1-based line and column, the
 * shape the agent API reports every annotation target in. `Text.lineAt`
 * throws for an out-of-range offset rather than clamping — every offset
 * reaching this function comes from a validated anchor, so that is the
 * correct failure mode, not a defect to work around.
 */
function offsetToLineColumn(text: string, offset: number): { line: number; column: number } {
  const line = Text.of(text.split("\n")).lineAt(offset);
  return { line: line.number, column: offset - line.from + 1 };
}

/**
 * Projects one annotation's anchor into the wire's flat, always-UTF-16
 * target shape. `orphaned` carries no position: I6 says the honest answer to
 * lost text is a marker and Reattach, never a guessed location.
 */
function buildAnnotationTarget(
  anchor: TextAnnotation["anchor"],
  workingText: string,
): AnnotationResponse["target"] {
  if (anchor.state === "range") {
    const start = offsetToLineColumn(workingText, anchor.from);
    const end = offsetToLineColumn(workingText, anchor.to);
    return {
      state: "range",
      quotedText: anchor.quotedText,
      from: anchor.from,
      to: anchor.to,
      line: start.line,
      column: start.column,
      endLine: end.line,
      endColumn: end.column,
    };
  }
  if (anchor.state === "point") {
    const at = offsetToLineColumn(workingText, anchor.at);
    return {
      state: "point",
      quotedText: anchor.quotedText,
      at: anchor.at,
      line: at.line,
      column: at.column,
      reason: anchor.reason,
    };
  }
  return {
    state: "orphaned",
    quotedText: anchor.quotedText,
    reason: anchor.reason,
  };
}

function buildAnnotationResponse(
  annotation: TextAnnotation,
  annotationGeneration: number,
  workingText: string,
): AnnotationResponse {
  return {
    annotationId: annotation.annotationId,
    documentId: annotation.documentId,
    target: buildAnnotationTarget(annotation.anchor, workingText),
    state: annotation.state,
    agentStatus: annotation.agentStatus,
    messages: annotation.messages,
    proposalActions: annotation.proposalActions,
    annotationGeneration,
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt,
    resolvedAt: annotation.resolvedAt,
  };
}

export default class AgentDocumentQueries {
  constructor(
    private readonly documents: DocumentManager,
    private readonly reviews: ReviewQueryPort,
    private readonly annotations: AnnotationQueryPort,
    private readonly app: AgentDocumentQueryHost,
    private readonly log: LogProvider,
  ) {}

  public async getDocumentSummary(documentId: string): Promise<DocumentSummary | undefined> {
    const filePath = this.documents.getDocumentPath(documentId);
    if (filePath === undefined) {
      return undefined;
    }
    const document = this.documents.loadedDocuments.find(
      (candidate) => candidate.filePath === filePath,
    );
    if (document === undefined) {
      return undefined;
    }
    const content = document.document.toString();
    const review = this.reviews.getStatus(documentId);
    return {
      documentId,
      uri: `safe-file://${filePath}`,
      path: filePath,
      name: path.basename(filePath),
      type: document.type === DocumentType.Markdown ? "markdown" : "code",
      dirty: document.currentVersion !== document.lastSavedVersion,
      revision: { sha256: sha256Text(content) },
      lineCount: content.split("\n").length,
      byteLength: Buffer.byteLength(content, "utf8"),
      views: await this.getViewsForDocument(documentId),
      review: review ?? undefined,
    };
  }

  public async getViewsForDocument(documentId: string): Promise<EditorViewSummary[]> {
    const focusedView = this.documents.getFocusedView();
    const views: EditorViewSummary[] = [];
    await this.documents.forEachLeaf(async (tabMan, windowId, leafId) => {
      const isOpenHere = tabMan.openFiles.some(
        (openFile) => this.documents.getDocumentId(openFile.path) === documentId,
      );
      if (!isOpenHere) {
        return false;
      }
      const isFocused =
        focusedView !== undefined &&
        focusedView.windowId === windowId &&
        focusedView.leafId === leafId;
      views.push({
        viewId: `view-${windowId}-${leafId}`,
        windowId,
        leafId,
        focused: isFocused,
        active:
          tabMan.activeFile !== null &&
          this.documents.getDocumentId(tabMan.activeFile.path) === documentId,
      });
      return false;
    });
    return views;
  }

  public async listDocuments(): Promise<DocumentSummary[]> {
    const documents: DocumentSummary[] = [];
    for (const document of this.documents.loadedDocuments) {
      const summary = await this.getDocumentSummary(document.documentId);
      if (summary !== undefined) {
        documents.push(summary);
      }
    }
    return documents;
  }

  /**
   * The annotations of one document, open or closed. Undefined when
   * documentId names no document this manager knows — the caller's signal
   * to answer DOCUMENT_NOT_FOUND rather than an empty list. A closed
   * document's annotations come from its persisted sidecar, so what the
   * UI workspace panel shows for that file is exactly what this answers.
   */
  public async listDocumentAnnotations(
    documentId: string,
    state: "open" | "resolved" | undefined,
  ): Promise<AnnotationListResponse | undefined> {
    const filePath = this.documents.getDocumentPath(documentId);
    if (filePath === undefined) {
      return undefined;
    }
    const located = await this._annotationDocument(documentId);
    if (located === undefined) {
      return { annotations: [] };
    }
    const items =
      state === undefined
        ? located.annotations.items
        : located.annotations.items.filter((item) => item.state === state);
    return {
      annotations: items.map((item) =>
        buildAnnotationResponse(item, located.annotations.generation, located.workingText),
      ),
    };
  }

  /**
   * Every annotation across the workspace — the same set the UI annotations
   * panel can show. Open documents read their live state; closed documents
   * read their persisted sidecars. With no `state` filter this returns every
   * annotation, including resolved ones; callers may explicitly narrow to one
   * lifecycle state.
   */
  public async listAnnotations(
    state: "open" | "resolved" | undefined,
  ): Promise<AnnotationListResponse> {
    const annotations: AnnotationResponse[] = [];
    for (const located of await this._annotationDocuments()) {
      for (const item of located.annotations.items) {
        if (state === undefined || item.state === state) {
          annotations.push(
            buildAnnotationResponse(item, located.annotations.generation, located.workingText),
          );
        }
      }
    }
    return { annotations };
  }

  /**
   * Locate one annotation by id alone, across the whole workspace — the
   * lookup `GET /v1/annotations/{annotationId}` and the reply endpoint both
   * need, since neither carries a documentId.
   */
  public async findAnnotationQuery(
    annotationId: string,
  ): Promise<LocatedAnnotation | undefined> {
    for (const located of await this._annotationDocuments()) {
      const found = located.annotations.items.find((item) => item.annotationId === annotationId);
      if (found !== undefined) {
        return {
          documentId: located.documentId,
          annotation: found,
          annotationGeneration: located.annotations.generation,
          workingText: located.workingText,
        };
      }
    }
    return undefined;
  }

  /**
   * Every document that has annotation state, open or closed — the merged
   * projection behind the annotations routes. Open documents read their live
   * state; closed documents read the sidecar that carries exactly what the
   * UI workspace panel shows for them.
   *
   * A sidecar outside every configured workspace is not served: the sidecar
   * directory is keyed by path hash, not provenance, and a workspace removed
   * since the sidecar was written must not leak into an agent's answer.
   */
  private async _annotationDocuments(): Promise<
    Array<{
      documentId: string;
      open: boolean;
      workingText: string;
      annotations: AnnotationSet;
    }>
  > {
    const documents: Array<{
      documentId: string;
      open: boolean;
      workingText: string;
      annotations: AnnotationSet;
    }> = [];
    const detachedPaths = new Set<string>();
    for (const document of this.documents.loadedDocuments) {
      documents.push({
        documentId: document.documentId,
        open: true,
        workingText: document.document.toString(),
        annotations: this.annotations.getAnnotations(document.documentId),
      });
      detachedPaths.add(path.resolve(document.filePath));
    }
    for (const sidecar of await this.annotations.listCollaborationSidecars()) {
      if (detachedPaths.has(path.resolve(sidecar.documentPath))) {
        continue;
      }
      if (!(await this.isOpenable(sidecar.documentPath))) {
        continue;
      }
      documents.push({
        documentId: this.documents.ensureDocumentId(sidecar.documentPath),
        open: false,
        workingText: sidecar.workingText,
        annotations: sidecar.annotations,
      });
    }
    return documents;
  }

  /**
   * One document's annotation-bearing projection, whatever it is: the live
   * state of an open document, or the persisted sidecar of a closed one.
   * Undefined when neither half holds annotations — a document with no
   * annotation state is the caller's empty answer, not this function's.
   */
  private async _annotationDocument(
    documentId: string,
  ): Promise<{ open: boolean; workingText: string; annotations: AnnotationSet } | undefined> {
    const filePath = this.documents.getDocumentPath(documentId);
    if (filePath !== undefined) {
      const document = this.documents.loadedDocuments.find(
        (candidate) => candidate.documentId === documentId,
      );
      if (document !== undefined) {
        return {
          open: true,
          workingText: document.document.toString(),
          annotations: this.annotations.getAnnotations(documentId),
        };
      }
      if (!(await this.isOpenable(filePath))) {
        return undefined;
      }
      const sidecar = await this.annotations
        .listCollaborationSidecars()
        .then((sidecars) =>
          sidecars.find(
            (candidate) => path.resolve(candidate.documentPath) === path.resolve(filePath),
          ),
        );
      if (sidecar !== undefined) {
        return {
          open: false,
          workingText: sidecar.workingText,
          annotations: sidecar.annotations,
        };
      }
    }
    // The id may have been minted for a closed document this manager has
    // never seen open (a workspace listing hands those out). Scan the
    // sidecars for it rather than returning nothing: findAnnotationQuery
    // serves those ids, so per-document reads must too.
    for (const sidecar of await this.annotations.listCollaborationSidecars()) {
      if (this.documents.ensureDocumentId(sidecar.documentPath) === documentId) {
        if (!(await this.isOpenable(sidecar.documentPath))) {
          return undefined;
        }
        return {
          open: false,
          workingText: sidecar.workingText,
          annotations: sidecar.annotations,
        };
      }
    }
    return undefined;
  }

  /**
   * One annotation's full detail, wire-shaped, or undefined if unknown.
   */
  public async getAnnotation(annotationId: string): Promise<AnnotationResponse | undefined> {
    const located = await this.findAnnotationQuery(annotationId);
    if (located === undefined) {
      return undefined;
    }
    return buildAnnotationResponse(
      located.annotation,
      located.annotationGeneration,
      located.workingText,
    );
  }

  public async getContext(): Promise<EditorContext> {
    const focusedView = this.documents.getFocusedView();
    const focusedDocument =
      focusedView?.documentId === undefined
        ? undefined
        : await this.getDocumentSummary(focusedView.documentId);
    return {
      focusedView:
        focusedView === undefined || focusedView.documentId === undefined
          ? undefined
          : {
              viewId: focusedView.viewId,
              windowId: focusedView.windowId,
              leafId: focusedView.leafId,
              documentId: focusedView.documentId,
            },
      focusedDocument,
      openDocuments: await this.listDocuments(),
    };
  }

  public async listViews(): Promise<ViewSummary[]> {
    const focusedView = this.documents.getFocusedView();
    const views: ViewSummary[] = [];
    await this.documents.forEachLeaf(async (tabMan, windowId, leafId) => {
      const activePath = tabMan.activeFile?.path;
      const isFocused =
        focusedView !== undefined &&
        focusedView.windowId === windowId &&
        focusedView.leafId === leafId;
      views.push({
        viewId: `view-${windowId}-${leafId}`,
        windowId,
        leafId,
        documentId: activePath === undefined ? undefined : this.documents.getDocumentId(activePath),
        focused: isFocused,
        active: isFocused,
        documents: tabMan.openFiles.map((openFile) => ({
          documentId: this.documents.getDocumentId(openFile.path),
          path: openFile.path,
        })),
      });
      return false;
    });
    return views;
  }

  public listWorkspaces(): Array<{ workspaceId: string; path: string }> {
    return this.app.config.get().app.openWorkspaces.map((workspacePath) => ({
      workspaceId: workspacePath,
      path: workspacePath,
    }));
  }

  /**
   * Every file a workspace holds, flat, open or not. Undefined when
   * `workspacePath` names no configured workspace, so the route can answer 404
   * rather than an empty listing.
   */
  public async listWorkspaceFilesByWorkspace(
    workspacePath: string,
  ): Promise<WorkspaceFileEntry[] | undefined> {
    if (!this.app.config.get().app.openWorkspaces.includes(workspacePath)) {
      return undefined;
    }
    const files: WorkspaceFileEntry[] = [];
    const wikilinks = this.app.links.index;
    for (const filePath of await this.documents.getFilesForWorkspace(workspacePath)) {
      files.push({
        documentId: this.documents.ensureDocumentId(filePath),
        path: filePath,
        name: path.basename(filePath),
        workspaceId: workspacePath,
        open: this.documents.loadedDocuments.some((document) => document.filePath === filePath),
        ...(wikilinks.has(filePath) ? { linkTarget: wikilinks.canonical(filePath) } : {}),
      });
    }
    return files;
  }

  /**
   * Every file across every configured workspace, flat, open or not. The
   * orientation projection behind `getContext`; the per-workspace
   * `include=files` listing shares its entry shape.
   */
  public async listWorkspaceFiles(): Promise<WorkspaceFileEntry[]> {
    const files: WorkspaceFileEntry[] = [];
    for (const workspacePath of this.app.config.get().app.openWorkspaces) {
      files.push(...(await this.listWorkspaceFilesByWorkspace(workspacePath)));
    }
    return files;
  }

  public async listWorkspaceDocuments(
    workspacePath: string,
    query: string | undefined,
  ): Promise<{ workspaceId: string; documents: WorkspaceDocumentEntry[] } | undefined> {
    if (!this.app.config.get().app.openWorkspaces.includes(workspacePath)) {
      return undefined;
    }
    const normalizedQuery = query === undefined ? "" : query.toLowerCase().trim();
    const documents: WorkspaceDocumentEntry[] = [];
    for (const documentPath of await this.documents.getFilesForWorkspace(workspacePath)) {
      const documentId = this.documents.ensureDocumentId(documentPath);
      if (normalizedQuery.length > 0 && !documentPath.toLowerCase().includes(normalizedQuery)) {
        continue;
      }
      const summary = await this.getDocumentSummary(documentId);
      documents.push(
        summary === undefined
          ? {
              documentId,
              uri: `safe-file://${documentPath}`,
              path: documentPath,
              name: path.basename(documentPath),
              workspaceId: workspacePath,
              loaded: false,
            }
          : { ...summary, workspaceId: workspacePath, loaded: true },
      );
    }
    return { workspaceId: workspacePath, documents };
  }

  /**
   * The text of a workspace document, open or closed: the live buffer, the
   * working text a saved review holds for a closed file, or the file on disk.
   */
  private async documentText(
    documentId: string,
  ): Promise<DocumentText | "OUTSIDE_WORKSPACE" | undefined> {
    const filePath = this.documents.getDocumentPath(documentId);
    if (filePath === undefined) {
      return undefined;
    }
    if (!(await this.isOpenable(filePath))) {
      return "OUTSIDE_WORKSPACE";
    }
    const document = this.documents.loadedDocuments.find(
      (candidate) => candidate.filePath === filePath,
    );
    if (document !== undefined) {
      const working = document.document.toString();
      const review = this.reviews.getReview(documentId);
      return {
        attached: true,
        working,
        reference:
          review === undefined ? working : reviewReferenceText(review.suggestions, working),
        reviewGeneration: review?.generation ?? 0,
      };
    }
    const sidecar = await this.reviews.readSidecar(filePath);
    if (sidecar !== undefined) {
      const working = sidecar.workingText;
      return {
        attached: false,
        working,
        reference:
          sidecar.review === null
            ? working
            : reviewReferenceText(sidecar.review.suggestions, working),
        reviewGeneration: sidecar.review?.generation ?? 0,
      };
    }
    const working = normalizeText(await this.documents.readSupportedFile(filePath));
    return {
      attached: false,
      working,
      reference: working,
      reviewGeneration: 0,
    };
  }

  public async readDocumentContent(
    documentId: string,
    side: ReadSide,
    startLine: number,
    endLine: number,
  ): Promise<ReadDocumentResponse | "OUTSIDE_WORKSPACE" | undefined> {
    const resolved = await this.documentText(documentId);
    if (resolved === undefined || resolved === "OUTSIDE_WORKSPACE") {
      return resolved;
    }
    const { attached, working, reference, reviewGeneration } = resolved;
    const text = side === "working" ? working : reference;
    const lines = text.split("\n");
    const totalLines = lines.length;
    const safeStartLine = Math.max(1, Math.min(startLine, totalLines));
    const safeEndLine = Math.max(safeStartLine, Math.min(endLine, totalLines));
    return {
      documentId,
      attached,
      side,
      revision: { sha256: sha256Text(text) },
      reviewGeneration,
      range: {
        startLine: safeStartLine,
        endLine: safeEndLine,
        totalLines,
      },
      content: lines.slice(safeStartLine - 1, safeEndLine).join("\n"),
      truncated: safeEndLine < totalLines,
    };
  }

  public async searchDocument(
    documentId: string,
    request: SearchDocumentRequest,
  ): Promise<SearchDocumentResponse | "OUTSIDE_WORKSPACE" | undefined> {
    const resolved = await this.documentText(documentId);
    if (resolved === undefined || resolved === "OUTSIDE_WORKSPACE") {
      return resolved;
    }
    let searchRegex: RegExp | undefined;
    let patternFailure: unknown;
    try {
      searchRegex = makeSearchRegex(request.literal, "g");
    } catch (error) {
      patternFailure = error;
    }
    if (searchRegex === undefined) {
      throw new SearchPatternError(patternFailure);
    }
    const content = resolved.working;
    const lines = content.split("\n");
    const contextSize = request.context ?? SEARCH_CONTEXT_DEFAULT;
    let collected: ReturnType<typeof collectSearchHits>;
    try {
      collected = vm.runInNewContext(
        "collectSearchHits(lines, searchRegex, contextSize, maxHits)",
        {
          collectSearchHits,
          lines,
          searchRegex,
          contextSize,
          maxHits: MAX_SEARCH_HITS,
        },
        { timeout: SEARCH_DEADLINE_MS },
      ) as ReturnType<typeof collectSearchHits>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
        throw new SearchTimeoutError();
      }
      throw error;
    }
    return {
      documentId,
      revision: { sha256: sha256Text(content) },
      hits: collected.hits,
      truncated: collected.truncated,
    };
  }

  /**
   * Every folder a workspace holds, recursively, relative to the workspace
   * root. A folder whose name the ignore rules hide does not enter the walk
   * (`readDirectoryRecursively`), so the listing is the same set the file
   * manager shows. The workspace root itself is not a child and is not listed.
   */
  public async listWorkspaceDirectories(
    workspacePath: string,
  ): Promise<WorkspaceDirectoriesResponse | undefined> {
    if (!this.app.config.get().app.openWorkspaces.includes(workspacePath)) {
      return undefined;
    }
    const fsal = this.app.fsal;
    if (fsal === undefined) {
      throw new Error("The workspace directory listing has no filesystem access");
    }
    const allPaths = await fsal.readDirectoryRecursively(workspacePath);
    const directories: WorkspaceDirectoryEntry[] = [];
    for (const candidate of allPaths) {
      if (candidate === workspacePath || !(await fsal.isDir(candidate))) {
        continue;
      }
      directories.push({
        path: candidate,
        name: path.basename(candidate),
        workspaceId: workspacePath,
        parent: path.dirname(candidate),
      });
    }
    return { workspaceId: workspacePath, directories };
  }

  /**
   * Creates one file or folder inside a workspace. `path` is absolute or
   * relative to `workspaceId`; the destination folder must already exist, so
   * one call creates one entry. Containment is enforced on the realpath of the
   * destination itself (its parent for a new file or folder), which is what
   * makes a symlinked workspace root and a `..` in a relative path both safe.
   */
  public async createWorkspaceEntry(
    request: WorkspaceEntryCreateRequest,
  ): Promise<WorkspaceEntryCreation> {
    if (request.kind !== "file" && request.kind !== "folder") {
      return {
        ok: false,
        code: "INVALID_PARAMS",
        message: "kind must be 'file' or 'folder'",
      };
    }

    let targetPath: string;
    if (path.isAbsolute(request.path)) {
      targetPath = path.normalize(request.path);
    } else if (request.workspaceId !== undefined && request.workspaceId !== "") {
      if (!this.app.config.get().app.openWorkspaces.includes(request.workspaceId)) {
        return {
          ok: false,
          code: "WORKSPACE_NOT_FOUND",
          message: `Workspace not found: ${request.workspaceId}`,
        };
      }
      targetPath = path.resolve(request.workspaceId, request.path);
    } else {
      return {
        ok: false,
        code: "INVALID_PARAMS",
        message: "A relative path requires workspaceId",
      };
    }

    const fsal = this.app.fsal;
    if (fsal === undefined) {
      return {
        ok: false,
        code: "PERSISTENCE_FAILED",
        message: "The workspace entry creation has no filesystem access",
      };
    }

    // The destination folder must exist before containment can be judged: a
    // new file or folder is created *inside* a folder that is already there.
    const parentDirectory = path.dirname(targetPath);
    if (!(await fsal.isDir(parentDirectory))) {
      return {
        ok: false,
        code: "INVALID_PARAMS",
        message: `The destination folder does not exist: ${parentDirectory}`,
      };
    }

    const workspace = await this.containingWorkspace(parentDirectory);
    if (workspace === undefined) {
      return {
        ok: false,
        code: "WORKSPACE_OUTSIDE_SCOPE",
        message: "The destination is outside every configured workspace",
      };
    }

    if (await fsal.pathExists(targetPath)) {
      return {
        ok: false,
        code: "WORKSPACE_ENTRY_EXISTS",
        message: `An entry already exists at ${targetPath}`,
      };
    }

    if (request.kind === "folder") {
      await fsal.createDir(targetPath);
    } else {
      if (request.content === undefined) {
        return {
          ok: false,
          code: "INVALID_PARAMS",
          message: "content is required for a file",
        };
      }
      await fsal.createFile(targetPath, request.content);
    }

    return {
      ok: true,
      entry: {
        kind: request.kind,
        path: targetPath,
        name: path.basename(targetPath),
        workspaceId: workspace,
      },
    };
  }

  /**
   * The configured workspace that contains `absPath`, or undefined. Both sides
   * are realpath'd so a symlinked workspace root compares against a symlinked
   * target; a destination that does not exist yet canonicalizes through its
   * existing parent.
   */
  private async containingWorkspace(absPath: string): Promise<string | undefined> {
    for (const workspacePath of this.app.config.get().app.openWorkspaces) {
      if (await this.isOpenableInWorkspace(absPath, workspacePath)) {
        return workspacePath;
      }
    }
    return undefined;
  }

  public async isOpenable(filePath: string): Promise<boolean> {
    const workspaces = this.app.config.get().app.openWorkspaces;
    if (workspaces.length === 0) {
      return this.documents.loadedDocuments.some((document) => document.filePath === filePath);
    }
    for (const workspacePath of workspaces) {
      if (await this.isOpenableInWorkspace(filePath, workspacePath)) {
        return true;
      }
    }
    return false;
  }

  private async isOpenableInWorkspace(filePath: string, workspacePath: string): Promise<boolean> {
    let canonicalFilePath: string;
    try {
      canonicalFilePath = await fs.promises.realpath(filePath);
    } catch {
      return false;
    }

    let canonicalWorkspacePath: string;
    try {
      canonicalWorkspacePath = await fs.promises.realpath(workspacePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
      this.log.warning(
        `[AgentHTTPProvider] Configured workspace ${workspacePath} could not be resolved ` +
          `(${code}); treating it as not containing ${filePath}. The workspace is ` +
          "probably deleted or unmounted.",
      );
      return false;
    }
    const relativePath = path.relative(canonicalWorkspacePath, canonicalFilePath);
    return (
      relativePath === "" ||
      (!relativePath.startsWith(`..${path.sep}`) &&
        relativePath !== ".." &&
        !path.isAbsolute(relativePath))
    );
  }
}
