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
  DocumentSummary,
  EditorViewSummary,
} from "@dts/common/agent-api";
import { DocumentType } from "@dts/common/documents";
import type DocumentManager from "@providers/documents";
import type LogProvider from "@providers/log";
import fs from "fs";
import path from "path";
import { sha256Text } from "@common/util/sha256";

export interface AgentDocumentQueryHost {
  config: {
    get: () => { app: { openWorkspaces: string[] } };
  };
}

export default class AgentDocumentQueries {
  constructor(
    private readonly documents: DocumentManager,
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
    const review = this.documents.reviewStatus(documentId);
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

  public findDocumentIdByReviewId(reviewId: string): string | undefined {
    for (const review of this.documents.reviewStore.listReviews()) {
      if (review.reviewId === reviewId) {
        return review.documentId;
      }
    }
    return undefined;
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
