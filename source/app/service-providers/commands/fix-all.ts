/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        FixAll command
 * CVM-Role:        Controller
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Applies Flowmark's machine-applicable fixes to the focused
 *                  document, the open documents or the workspace. Flowmark
 *                  decides which findings carry a `fix`; this command only
 *                  applies them.
 *
 *                  - 'preview-fix-all' { scope } lints the scope through the
 *                    lint cache and returns the plan: per document, the
 *                    fixes of one pass and the hash of the text they were
 *                    planned on. Nothing changes.
 *                  - 'commit-fix-all' { plan } applies the plan through the
 *                    journaled workspace-edit transaction, fenced by those
 *                    hashes: a document that changed since the preview is a
 *                    conflict, and then nothing is applied anywhere. Open
 *                    buffers change through the document authority and are
 *                    saved; closed files are written.
 *
 * END HEADER
 */

import { hasMarkdownExt } from "@common/util/file-extention-checks";
import type { FixAllOutcome, FixAllPlan, FixAllRequest } from "@dts/common/fix-all";
import type { ApplyProblemFixRequest, ListProblemsRequest, WorkspaceProblems } from "@dts/common/problems";
import type { WorkspaceTextEdit } from "@dts/common/references";
import { app } from "electron";
import type { AppServiceContainer } from "source/app/app-service-container";
import {
  runWorkspaceEditTransaction,
  saveUpdatedBuffers,
} from "../references/workspace-edit-transaction";
import ZettlrCommand from "./zettlr-command";

export default class FixAll extends ZettlrCommand {
  constructor(app: AppServiceContainer) {
    super(app, ["preview-fix-all", "commit-fix-all", "list-workspace-lint", "apply-lint-fix"]);
  }

  async run(
    evt: string,
    arg: FixAllRequest | { plan: FixAllPlan } | ListProblemsRequest | ApplyProblemFixRequest,
  ): Promise<FixAllPlan | FixAllOutcome | WorkspaceProblems> {
    if (evt === "list-workspace-lint") {
      if (!("scope" in arg) || (arg.scope !== "workspace" && arg.scope !== "all")) {
        throw new Error("list-workspace-lint requires a workspace or all scope");
      }
      return await this._app.documentLint.workspaceProblems(arg);
    }
    if (evt === "apply-lint-fix") {
      if (!("documentPath" in arg) || !("sourceHash" in arg)) {
        throw new Error("apply-lint-fix requires a document path and source hash");
      }
      if (!(await this._app.documentLint.hasCurrentFix(arg))) {
        return { status: "conflict", documentPath: arg.documentPath };
      }
      return await this.commit({
        documents: [{
          documentPath: arg.documentPath,
          sourceHash: arg.sourceHash,
          edits: [{ from: arg.from, to: arg.to, insert: arg.replacement, rule: "" }],
        }],
        documentsChecked: 1,
        unlinted: [],
      });
    }
    if (evt === "preview-fix-all") {
      if (!("scope" in arg) || arg.scope === "all") {
        throw new Error("preview-fix-all requires a scope");
      }
      const request: FixAllRequest = arg.scope === "document" && "documentPath" in arg
        ? { scope: "document", documentPath: arg.documentPath }
        : { scope: arg.scope };
      return await this._app.documentLint.planFixes(await this.documentsIn(request));
    }
    if (!("plan" in arg)) {
      throw new Error("commit-fix-all requires a plan");
    }
    return await this.commit(arg.plan);
  }

  private async documentsIn(request: FixAllRequest): Promise<string[]> {
    switch (request.scope) {
      case "document":
        return [request.documentPath];
      case "open":
        return this._app.documents.loadedDocuments
          .map((document) => document.filePath)
          .filter((filePath) => hasMarkdownExt(filePath));
      case "workspace":
        return await this._app.documentLint.workspaceDocuments();
    }
  }

  private async commit(plan: FixAllPlan): Promise<FixAllOutcome> {
    const edits: WorkspaceTextEdit[] = plan.documents.flatMap((document) =>
      document.edits.map((edit) => ({
        documentPath: document.documentPath,
        range: { from: edit.from, to: edit.to },
        insert: edit.insert,
      })),
    );
    const expectedSourceHashes = Object.fromEntries(
      plan.documents.map((document) => [document.documentPath, document.sourceHash]),
    );
    const documents = this._app.documents;
    const result = await runWorkspaceEditTransaction(documents, app.getPath("userData"), {
      edits,
      expectedSourceHashes,
    });
    if (result.status === "conflict") {
      return { status: "conflict", documentPath: result.documentPath };
    }
    await saveUpdatedBuffers(
      async (documentPath) => await documents.saveFile(documentPath),
      result.openBuffersUpdated,
    );
    return {
      status: "applied",
      fixesApplied: edits.length,
      documentsChanged: [...result.openBuffersUpdated, ...result.closedFilesWritten],
    };
  }
}
