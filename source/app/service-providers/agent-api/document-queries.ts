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

import type {
  AnnotationListResponse,
  AnnotationResponse,
  EditorContext,
  DocumentSummary,
  EditorViewSummary,
  ReadDocumentResponse,
  ReadSide,
  SearchDocumentRequest,
  SearchDocumentResponse,
  ViewSummary,
  WorkspaceDocumentEntry,
  WorkspaceFileEntry,
} from "@dts/common/agent-api";
import type { AnnotationSet, TextAnnotation } from "@dts/common/annotation-domain";
import { Text } from "@codemirror/state";
import { DocumentType } from "@dts/common/documents";
import type DocumentManager from "@providers/documents";
import type LogProvider from "@providers/log";
import type { CollaborationApplicationService, ReviewQueryPort } from "@providers/documents/document-collaboration-application-service";
import fs from "fs";
import path from "path";
import vm from "vm";
import { sha256Text } from "@common/util/sha256";
import makeSearchRegex from "source/common/util/make-search-regex";
import {
  normalizeText,
  reviewReferenceText,
} from "@providers/documents/review-diff-store";

const SEARCH_CONTEXT_DEFAULT = 3;
const SEARCH_DEADLINE_MS = 1000;
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
}

/**
 * Read-only annotation projections for transport providers. Annotation
 * mutation is a separate, narrower surface (DocumentManager.addAnnotationMessage)
 * — the only annotation write the agent HTTP API exposes (I3).
 */
export type AnnotationQueryPort = Pick<CollaborationApplicationService, "getAnnotations">;

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
    const document = this.documents.loadedDocuments.find((candidate) => candidate.filePath === filePath);
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
   * Every annotation of one open document. Undefined when documentId names no
   * document this manager knows — the caller's signal to answer
   * DOCUMENT_NOT_FOUND rather than an empty list. A known-but-closed document
   * has no queryable annotation state: the sidecar is not scanned here.
   */
  public async listDocumentAnnotations(
    documentId: string,
    state: "open" | "resolved" | undefined,
  ): Promise<AnnotationListResponse | undefined> {
    const filePath = this.documents.getDocumentPath(documentId);
    if (filePath === undefined) {
      return undefined;
    }
    const document = this.documents.loadedDocuments.find(
      (candidate) => candidate.documentId === documentId,
    );
    if (document === undefined) {
      return { annotations: [] };
    }
    const workingText = document.document.toString();
    const set: AnnotationSet = this.annotations.getAnnotations(documentId);
    const items = state === undefined ? set.items : set.items.filter((item) => item.state === state);
    return {
      annotations: items.map((item) => buildAnnotationResponse(item, set.generation, workingText)),
    };
  }

  /**
   * Every annotation across every currently open document. `state` narrows to
   * one lifecycle state and defaults to `open` — the annotations with a
   * thread to read or reply to, matching the OpenAPI document's declared
   * default.
   */
  public async listAnnotations(
    state: "open" | "resolved" = "open",
  ): Promise<AnnotationListResponse> {
    const annotations: AnnotationResponse[] = [];
    for (const document of this.documents.loadedDocuments) {
      const workingText = document.document.toString();
      const set: AnnotationSet = this.annotations.getAnnotations(document.documentId);
      for (const item of set.items) {
        if (item.state === state) {
          annotations.push(buildAnnotationResponse(item, set.generation, workingText));
        }
      }
    }
    return { annotations };
  }

  /**
   * Locate one annotation by id alone, across every open document — the
   * lookup `GET /v1/annotations/{annotationId}` and the reply endpoint both
   * need, since neither carries a documentId.
   */
  public async findAnnotationQuery(
    annotationId: string,
  ): Promise<{ documentId: string; annotation: TextAnnotation; annotationGeneration: number } | undefined> {
    for (const document of this.documents.loadedDocuments) {
      const set: AnnotationSet = this.annotations.getAnnotations(document.documentId);
      const found = set.items.find((item) => item.annotationId === annotationId);
      if (found !== undefined) {
        return { documentId: document.documentId, annotation: found, annotationGeneration: set.generation };
      }
    }
    return undefined;
  }

  /** One annotation's full detail, wire-shaped, or undefined if unknown. */
  public async getAnnotation(annotationId: string): Promise<AnnotationResponse | undefined> {
    const located = await this.findAnnotationQuery(annotationId);
    if (located === undefined) {
      return undefined;
    }
    const document = this.documents.loadedDocuments.find(
      (candidate) => candidate.documentId === located.documentId,
    );
    const workingText = document === undefined ? "" : document.document.toString();
    return buildAnnotationResponse(located.annotation, located.annotationGeneration, workingText);
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
        documentId:
          activePath === undefined ? undefined : this.documents.getDocumentId(activePath),
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

  public async listWorkspaceFiles(): Promise<WorkspaceFileEntry[]> {
    const files: WorkspaceFileEntry[] = [];
    for (const workspacePath of this.app.config.get().app.openWorkspaces) {
      for (const filePath of await this.documents.getFilesForWorkspace(workspacePath)) {
        files.push({
          documentId: this.documents.ensureDocumentId(filePath),
          path: filePath,
          name: path.basename(filePath),
          workspaceId: workspacePath,
          open: this.documents.loadedDocuments.some((document) => document.filePath === filePath),
        });
      }
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

  public async readDocumentContent(
    documentId: string,
    side: ReadSide,
    startLine: number,
    endLine: number,
  ): Promise<ReadDocumentResponse | "OUTSIDE_WORKSPACE" | undefined> {
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
    let attached = false;
    let working: string;
    let reference: string;
    let reviewGeneration = 0;
    if (document !== undefined) {
      attached = true;
      working = document.document.toString();
      const review = this.reviews.getReview(documentId);
      reference = review === undefined
        ? working
        : reviewReferenceText(review.suggestions, working);
      reviewGeneration = review?.generation ?? 0;
    } else {
      const sidecar = await this.reviews.readSidecar(filePath);
      if (sidecar !== undefined) {
        working = sidecar.workingText;
        reference = sidecar.review === null
          ? working
          : reviewReferenceText(sidecar.review.suggestions, working);
        reviewGeneration = sidecar.review?.generation ?? 0;
      } else {
        working = normalizeText(await this.documents.readSupportedFile(filePath));
        reference = working;
      }
    }

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

  public searchDocument(
    documentId: string,
    request: SearchDocumentRequest,
  ): SearchDocumentResponse | undefined {
    const document = this.documents.loadedDocuments.find(
      (candidate) => candidate.documentId === documentId,
    );
    if (document === undefined) {
      return undefined;
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
    const content = document.document.toString();
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

  private async isOpenableInWorkspace(
    filePath: string,
    workspacePath: string,
  ): Promise<boolean> {
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
