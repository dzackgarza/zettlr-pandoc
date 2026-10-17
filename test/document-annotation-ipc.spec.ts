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

// Installs process-wide test doubles; it must load before the modules that read them.
import "./headless-electron-harness.cjs";
import type { AnnotationMessage, TextAnnotation } from "@dts/common/annotation-domain";
import type { DocumentCollaborationSession } from "@dts/common/document-collaboration";
import type { CodeFileDescriptor } from "@dts/common/fsal";
import { strict as assert } from "assert";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import type { AppServiceContainer } from "source/app/app-service-container";
import DocumentManager from "source/app/service-providers/documents";
import type { AnnotationFailure } from "source/app/service-providers/documents/document-collaboration-application-service";
import LogProvider from "source/app/service-providers/log";
import { ipcMainHandlers } from "./headless-electron-harness.cjs";

type IpcHandler = (event: unknown, input: unknown) => Promise<unknown>;

/** The REAL registered listener for one 'documents:*' channel. */
function handler(channel: string): IpcHandler {
  const registered = ipcMainHandlers.get(channel) as IpcHandler | undefined;
  assert.ok(registered !== undefined, `constructing DocumentManager must register ${channel}`);
  return registered;
}

async function invoke<T>(channel: string, input: unknown): Promise<T> {
  return (await handler(channel)(undefined, input)) as T;
}

function isFailure(result: unknown): result is AnnotationFailure {
  return typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === false;
}

describe("Document annotation IPC (M6, WU-14)", function () {
  let scratch: string;
  let provider: DocumentManager;

  function descriptorFor(filePath: string): CodeFileDescriptor {
    const stat = statSync(filePath);
    return {
      path: filePath,
      dir: path.dirname(filePath),
      name: path.basename(filePath),
      ext: path.extname(filePath),
      type: "code",
      size: stat.size,
      modtime: stat.mtimeMs,
      creationtime: stat.birthtimeMs,
      bom: "",
      linefeed: "\n",
    };
  }

  function normalizedRead(filePath: string): string {
    return readFileSync(filePath, "utf8")
      .split(/\r\n|\n\r|\n|\r/g)
      .join("\n");
  }

  async function createProvider(): Promise<DocumentManager> {
    const watcherSeam = {
      on: () => {},
      getWatched: () => ({}),
      watchPath: (_path: string) => {},
      unwatchPath: (_path: string) => {},
      shutdown: async () => {},
    };
    const appSeam = {
      log: new LogProvider(),
      config: {
        get: () => ({
          app: { openFiles: [], openWorkspaces: [scratch] },
          system: { avoidNewTabs: false },
          editor: { autoSave: "off" as const },
          files: {
            images: { openWith: "zettlr" as const },
            pdf: { openWith: "zettlr" as const },
          },
          appLang: "en-US",
          alwaysReloadFiles: false,
        }),
        addPath: (_path: string) => false,
        set: (_key: string, _value: unknown) => {},
      },
      fsal: {
        getWatchdog: () => watcherSeam,
        testAccess: async () => true,
        getDescriptorForAnySupportedFile: async (filePath: string) => descriptorFor(filePath),
        loadAnySupportedFile: async (filePath: string) => normalizedRead(filePath),
        writeTextFile: async (filePath: string, content: string) => {
          writeFileSync(filePath, content, "utf8");
        },
        getDescriptorFor: async (filePath: string) => descriptorFor(filePath),
        getFilesystemMetadata: async (_filePath: string) => ({ modtime: 0 }),
        readDirectoryRecursively: async (workspacePath: string) =>
          readdirSync(workspacePath, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => path.join(entry.parentPath, entry.name)),
      },
      citeproc: { synchronizeDatabases: async (_libraries: string[]) => {} },
      recentDocs: { add: (_path: string) => {}, markEdited: (_path: string) => {} },
      stats: { updateCounts: (_words: number, _chars: number) => {} },
      windows: {
        askSaveChanges: async (_detail?: string) => ({ response: 2, checkboxChecked: false }),
        getFirstMainWindow: () => undefined,
        getMainWindowKey: (_window: unknown) => "",
      },
      references: {
        reportAuthorityBuffer: (_filePath: string) => {},
        dropAuthorityBuffer: (_filePath: string) => {},
      },
    };

    const manager = new DocumentManager(appSeam as unknown as AppServiceContainer);
    await manager.boot();
    return manager;
  }

  async function openFile(fileName: string, content: string): Promise<string> {
    const filePath = path.join(scratch, fileName);
    writeFileSync(filePath, content, "utf8");
    await provider.getDocument(filePath);
    const documentId = provider.getDocumentId(filePath);
    assert.ok(documentId !== undefined, "the opened file must be assigned a documentId");
    return filePath;
  }

  beforeEach(async function () {
    scratch = mkdtempSync(path.join(os.tmpdir(), "zettlr-annotation-ipc-"));
    provider = await createProvider();
  });

  afterEach(async function () {
    await provider.shutdown();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("creates an annotation through documents:create-annotation and reaches the real application service", async function () {
    const content = "Trust through transparency – make AI behavior understandable.\n";
    const filePath = await openFile("strategy.md", content);
    const from = content.indexOf("Trust through transparency");
    const to = from + "Trust through transparency".length;

    const created = await invoke<TextAnnotation | AnnotationFailure>(
      "documents:create-annotation",
      {
        path: filePath,
        from,
        to,
        instruction: "Expand this with concrete examples.",
        expectedAnnotationGeneration: 0,
      },
    );

    assert.ok(!isFailure(created), `expected a created annotation, got ${JSON.stringify(created)}`);
    const annotation = created as TextAnnotation;
    assert.deepEqual(annotation.anchor, {
      state: "range",
      from,
      to,
      quotedText: "Trust through transparency",
    });
    assert.equal(annotation.messages[0].author, "owner");
    assert.equal(annotation.messages[0].text, "Expand this with concrete examples.");
  });

  it("admits a second annotation that repeats an earlier creation instruction", async function () {
    const content = "First target here. Second target here.\n";
    const filePath = await openFile("repeated-reason.md", content);
    const firstFrom = content.indexOf("First target");
    const firstTo = firstFrom + "First target".length;
    const secondFrom = content.indexOf("Second target");
    const secondTo = secondFrom + "Second target".length;

    const first = await invoke<TextAnnotation | AnnotationFailure>("documents:create-annotation", {
      path: filePath,
      from: firstFrom,
      to: firstTo,
      instruction: "Explain why this assumption is needed.",
      expectedAnnotationGeneration: 0,
    });
    assert.ok(!isFailure(first), "the first annotation must be admitted");

    // The instruction is owner prose, not an identifier: repeating it, even
    // restyled, for another passage must be admitted like any other.
    const second = await invoke<TextAnnotation | AnnotationFailure>("documents:create-annotation", {
      path: filePath,
      from: secondFrom,
      to: secondTo,
      instruction: "  explain   WHY this assumption is needed.  ",
      expectedAnnotationGeneration: 1,
    });
    assert.ok(!isFailure(second), `expected a second annotation, got ${JSON.stringify(second)}`);

    const session = await invoke<
      { annotations: { generation: number; items: TextAnnotation[] } } | undefined
    >("documents-provider", { command: "get-collaboration-session", payload: { path: filePath } });
    assert.ok(session !== undefined);
    assert.equal(
      session.annotations.generation,
      2,
      "the repeated instruction must commit like any other",
    );
    assert.equal(
      session.annotations.items.length,
      2,
      "both annotations must be in annotation state",
    );
    assert.equal(
      session.annotations.items[1].messages[0].text,
      "  explain   WHY this assumption is needed.  ",
      "the instruction is stored verbatim",
    );
  });

  it("lists a closed workspace document from its persisted collaboration sidecar", async function () {
    const content = "A closed workspace target remains reviewable.\n";
    const filePath = await openFile("closed-workspace.md", content);
    const from = content.indexOf("workspace target");
    const to = from + "workspace target".length;

    const created = await invoke<TextAnnotation | AnnotationFailure>(
      "documents:create-annotation",
      {
        path: filePath,
        from,
        to,
        instruction: "Explain why this target matters.",
        expectedAnnotationGeneration: 0,
      },
    );
    assert.ok(!isFailure(created), "fixture annotation must be created before detaching");

    await provider.closeFileEverywhere(filePath);

    const sessions = await invoke<DocumentCollaborationSession[]>("documents-provider", {
      command: "get-workspace-collaboration-sessions",
      payload: { paths: [filePath] },
    });

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].documentPath, filePath);
    assert.equal(sessions[0].annotations.items.length, 1);
    assert.equal(
      sessions[0].annotations.items[0].annotationId,
      (created as TextAnnotation).annotationId,
    );
    assert.equal(sessions[0].review, undefined);
  });

  it("refuses documents:create-annotation for a path with no open document", async function () {
    const result = await invoke<TextAnnotation | AnnotationFailure>("documents:create-annotation", {
      path: path.join(scratch, "never-opened.md"),
      from: 0,
      to: 1,
      instruction: "x",
      expectedAnnotationGeneration: 0,
    });
    assert.ok(isFailure(result), "an unresolved path must be refused, not throw");
    assert.equal(result.code, "DOCUMENT_NOT_FOUND");
  });

  it("surfaces a real coordinate bounds violation through the channel unchanged", async function () {
    const content = "short\n";
    const filePath = await openFile("short.md", content);

    const result = await invoke<TextAnnotation | AnnotationFailure>("documents:create-annotation", {
      path: filePath,
      from: 0,
      to: content.length + 50,
      instruction: "x",
      expectedAnnotationGeneration: 0,
    });
    assert.ok(isFailure(result), "a target past the end of the document must be refused");
    assert.equal(result.code, "INVALID_PARAMS");
  });

  it("surfaces a real generation mismatch through the channel unchanged", async function () {
    const content = "One sentence here. Another sentence here.\n";
    const filePath = await openFile("two-sentences.md", content);
    const firstFrom = content.indexOf("One sentence here.");
    const firstTo = firstFrom + "One sentence here.".length;

    const first = await invoke<TextAnnotation | AnnotationFailure>("documents:create-annotation", {
      path: filePath,
      from: firstFrom,
      to: firstTo,
      instruction: "first",
      expectedAnnotationGeneration: 0,
    });
    assert.ok(!isFailure(first), "the first creation must succeed at generation 0");

    const secondFrom = content.indexOf("Another sentence here.");
    const secondTo = secondFrom + "Another sentence here.".length;
    const stale = await invoke<TextAnnotation | AnnotationFailure>("documents:create-annotation", {
      // Still claiming generation 0, which the first creation already advanced past.
      path: filePath,
      from: secondFrom,
      to: secondTo,
      instruction: "second",
      expectedAnnotationGeneration: 0,
    });
    assert.ok(isFailure(stale), "a stale expectedAnnotationGeneration must be refused");
    assert.equal(stale.code, "ANNOTATION_GENERATION_MISMATCH");
  });

  it("hardcodes actor: owner and never reads a forged actor field off the wire payload", async function () {
    const content = "Some annotatable sentence.\n";
    const filePath = await openFile("forged-actor.md", content);
    const from = content.indexOf("annotatable");
    const to = from + "annotatable".length;

    // No CreateAnnotationIpcInput field carries 'actor' — this simulates a
    // hand-crafted postMessage from a compromised renderer, not a value any
    // typed call site could produce.
    const forged = {
      path: filePath,
      from,
      to,
      instruction: "forged",
      expectedAnnotationGeneration: 0,
      actor: "agent",
    };
    const created = await invoke<TextAnnotation | AnnotationFailure>(
      "documents:create-annotation",
      forged,
    );
    assert.ok(!isFailure(created), "creation must still succeed");
    assert.equal(
      (created as TextAnnotation).messages[0].author,
      "owner",
      "the forged actor field must never reach the transition",
    );
  });

  it("wires documents:add-annotation-message to the real thread", async function () {
    const content = "Annotate this clause please.\n";
    const filePath = await openFile("message.md", content);
    const from = content.indexOf("this clause");
    const to = from + "this clause".length;

    const created = await invoke<TextAnnotation>("documents:create-annotation", {
      path: filePath,
      from,
      to,
      instruction: "first turn",
      expectedAnnotationGeneration: 0,
    });

    const messaged = await invoke<AnnotationMessage | AnnotationFailure>(
      "documents:add-annotation-message",
      {
        path: filePath,
        annotationId: created.annotationId,
        text: "a second turn",
        expectedAnnotationGeneration: 1,
      },
    );
    assert.ok(!isFailure(messaged), `expected a posted message, got ${JSON.stringify(messaged)}`);
    assert.equal((messaged as AnnotationMessage).text, "a second turn");
    assert.equal((messaged as AnnotationMessage).author, "owner");
  });

  it("wires documents:resolve-annotation and documents:reopen-annotation to the real lifecycle", async function () {
    const content = "Resolve and reopen this.\n";
    const filePath = await openFile("lifecycle.md", content);
    const from = content.indexOf("this");
    const to = from + "this".length;

    const created = await invoke<TextAnnotation>("documents:create-annotation", {
      path: filePath,
      from,
      to,
      instruction: "lifecycle",
      expectedAnnotationGeneration: 0,
    });

    const resolved = await invoke<TextAnnotation | AnnotationFailure>(
      "documents:resolve-annotation",
      {
        path: filePath,
        annotationId: created.annotationId,
        expectedAnnotationGeneration: 1,
      },
    );
    assert.ok(
      !isFailure(resolved),
      `expected a resolved annotation, got ${JSON.stringify(resolved)}`,
    );
    assert.equal((resolved as TextAnnotation).state, "resolved");

    const reopened = await invoke<TextAnnotation | AnnotationFailure>(
      "documents:reopen-annotation",
      {
        path: filePath,
        annotationId: created.annotationId,
        expectedAnnotationGeneration: 2,
      },
    );
    assert.ok(
      !isFailure(reopened),
      `expected a reopened annotation, got ${JSON.stringify(reopened)}`,
    );
    assert.equal((reopened as TextAnnotation).state, "open");
  });

  it("wires documents:reattach-annotation to a freshly picked range", async function () {
    const content = "First target here. Second target here.\n";
    const filePath = await openFile("reattach.md", content);
    const firstFrom = content.indexOf("First target");
    const firstTo = firstFrom + "First target".length;

    const created = await invoke<TextAnnotation>("documents:create-annotation", {
      path: filePath,
      from: firstFrom,
      to: firstTo,
      instruction: "reattach me",
      expectedAnnotationGeneration: 0,
    });

    const secondFrom = content.indexOf("Second target");
    const secondTo = secondFrom + "Second target".length;
    const reattached = await invoke<TextAnnotation | AnnotationFailure>(
      "documents:reattach-annotation",
      {
        path: filePath,
        annotationId: created.annotationId,
        from: secondFrom,
        to: secondTo,
        expectedAnnotationGeneration: 1,
      },
    );
    assert.ok(
      !isFailure(reattached),
      `expected a reattached annotation, got ${JSON.stringify(reattached)}`,
    );
    assert.deepEqual(
      (reattached as TextAnnotation).anchor,
      // quotedText survives the move unchanged (I1) — it still reads the ORIGINAL target.
      { state: "range", from: secondFrom, to: secondTo, quotedText: "First target" },
    );
  });

  it("wires documents:delete-annotation to the real removal", async function () {
    const content = "Delete this annotation.\n";
    const filePath = await openFile("delete.md", content);
    const from = content.indexOf("this annotation");
    const to = from + "this annotation".length;

    const created = await invoke<TextAnnotation>("documents:create-annotation", {
      path: filePath,
      from,
      to,
      instruction: "delete me",
      expectedAnnotationGeneration: 0,
    });

    const deleted = await invoke<TextAnnotation | AnnotationFailure>(
      "documents:delete-annotation",
      {
        path: filePath,
        annotationId: created.annotationId,
        expectedAnnotationGeneration: 1,
      },
    );
    assert.ok(
      !isFailure(deleted),
      `expected the deletion to succeed, got ${JSON.stringify(deleted)}`,
    );

    const session = await invoke<{ annotations: { items: TextAnnotation[] } } | undefined>(
      "documents-provider",
      { command: "get-collaboration-session", payload: { path: filePath } },
    );
    assert.ok(session !== undefined);
    assert.equal(
      session?.annotations.items.some((item) => item.annotationId === created.annotationId),
      false,
      "the deleted annotation must be gone from the session",
    );
  });

  /**
   * Marks one annotation acted the way the REAL agent path does — a real
   * agent disposition through the application service, not a hand-written
   * sidecar. Returns the annotation generation after the disposition.
   */
  async function actAnnotation(
    filePath: string,
    annotationId: string,
    generation: number,
  ): Promise<number> {
    const documentId = provider.getDocumentId(filePath);
    assert.ok(documentId !== undefined, "the fixture document must be loaded");
    const disposition = await provider.addAnnotationMessage(
      documentId,
      annotationId,
      "agent",
      "Implemented the requested correction in commit abc123.",
      `bulk-ipc-disposition-${annotationId}`,
      generation,
      true,
    );
    assert.ok(!isFailure(disposition), "the fixture agent disposition must be admitted");
    return generation + 1;
  }

  it("wires documents:resolve-acted-annotations to the acted open annotations of a document", async function () {
    const content = "Remediated target here. Open target here.\n";
    const filePath = await openFile("bulk-acted.md", content);
    const firstFrom = content.indexOf("Remediated target");
    const firstTo = firstFrom + "Remediated target".length;
    const secondFrom = content.indexOf("Open target");
    const secondTo = secondFrom + "Open target".length;

    const first = await invoke<TextAnnotation>("documents:create-annotation", {
      path: filePath,
      from: firstFrom,
      to: firstTo,
      instruction: "fix this",
      expectedAnnotationGeneration: 0,
    });
    const second = await invoke<TextAnnotation>("documents:create-annotation", {
      path: filePath,
      from: secondFrom,
      to: secondTo,
      instruction: "and this",
      expectedAnnotationGeneration: 1,
    });
    const actedGeneration = await actAnnotation(filePath, first.annotationId, 2);

    const resolved = await invoke<{ resolved: TextAnnotation[] } | AnnotationFailure>(
      "documents:resolve-acted-annotations",
      { path: filePath, expectedAnnotationGeneration: actedGeneration },
    );
    assert.ok(!isFailure(resolved), `expected a committed batch, got ${JSON.stringify(resolved)}`);
    assert.deepEqual(
      resolved.resolved.map((annotation) => annotation.annotationId),
      [first.annotationId],
      "exactly the acted annotation resolves, the untouched thread stays open",
    );
    assert.equal((resolved.resolved[0] as TextAnnotation).state, "resolved");

    const session = await invoke<{ annotations: { items: TextAnnotation[] } } | undefined>(
      "documents-provider",
      { command: "get-collaboration-session", payload: { path: filePath } },
    );
    assert.ok(session !== undefined);
    assert.equal(
      session.annotations.items.find((item) => item.annotationId === first.annotationId)?.state,
      "resolved",
    );
    assert.equal(
      session.annotations.items.find((item) => item.annotationId === second.annotationId)?.state,
      "open",
    );
  });

  it("wires documents:resolve-acted-annotations to a CLOSED document through its sidecar", async function () {
    const content = "A remediation backlog outlives the pane.\n";
    const filePath = await openFile("bulk-acted-closed.md", content);
    const from = content.indexOf("backlog");
    const to = from + "backlog".length;

    const created = await invoke<TextAnnotation>("documents:create-annotation", {
      path: filePath,
      from,
      to,
      instruction: "fix this when you can",
      expectedAnnotationGeneration: 0,
    });
    const actedGeneration = await actAnnotation(filePath, created.annotationId, 1);
    await provider.closeFileEverywhere(filePath);

    const resolved = await invoke<{ resolved: TextAnnotation[] } | AnnotationFailure>(
      "documents:resolve-acted-annotations",
      { path: filePath, expectedAnnotationGeneration: actedGeneration },
    );
    assert.ok(
      !isFailure(resolved),
      `a closed document's acted backlog must resolve: ${JSON.stringify(resolved)}`,
    );
    assert.deepEqual(
      resolved.resolved.map((annotation) => annotation.annotationId),
      [created.annotationId],
    );
  });

  it("scope open through documents:resolve-acted-annotations resolves plain pending threads too", async function () {
    const content = "First target here. Second target here.\n";
    const filePath = await openFile("bulk-open-scope.md", content);
    const firstFrom = content.indexOf("First target");
    const firstTo = firstFrom + "First target".length;
    const secondFrom = content.indexOf("Second target");
    const secondTo = secondFrom + "Second target".length;

    const first = await invoke<TextAnnotation>("documents:create-annotation", {
      path: filePath,
      from: firstFrom,
      to: firstTo,
      instruction: "nothing acted on this thread",
      expectedAnnotationGeneration: 0,
    });
    const second = await invoke<TextAnnotation>("documents:create-annotation", {
      path: filePath,
      from: secondFrom,
      to: secondTo,
      instruction: "nor this one",
      expectedAnnotationGeneration: 1,
    });

    const resolved = await invoke<{ resolved: TextAnnotation[] } | AnnotationFailure>(
      "documents:resolve-acted-annotations",
      { path: filePath, expectedAnnotationGeneration: 2, scope: "open" },
    );
    assert.ok(
      !isFailure(resolved),
      `expected the open-scope batch, got ${JSON.stringify(resolved)}`,
    );
    assert.deepEqual(
      (resolved as { resolved: TextAnnotation[] }).resolved.map(
        (annotation) => annotation.annotationId,
      ),
      [first.annotationId, second.annotationId],
    );
  });

  it("refuses documents:resolve-acted-annotations with nothing acted", async function () {
    const content = "Nothing acted here.\n";
    const filePath = await openFile("bulk-nothing-acted.md", content);
    const from = content.indexOf("Nothing");
    const to = from + "Nothing".length;
    await invoke<TextAnnotation>("documents:create-annotation", {
      path: filePath,
      from,
      to,
      instruction: "pending thread",
      expectedAnnotationGeneration: 0,
    });
    const result = await invoke<{ resolved: TextAnnotation[] } | AnnotationFailure>(
      "documents:resolve-acted-annotations",
      { path: filePath, expectedAnnotationGeneration: 1 },
    );
    assert.ok(isFailure(result), "an empty batch must be refused");
    assert.equal(result.code, "INVALID_PARAMS");
  });

  it("wires documents:clear-resolved-annotations to the resolved annotations of a document", async function () {
    const content = "Settled target here. Live target here.\n";
    const filePath = await openFile("bulk-cleanup.md", content);
    const firstFrom = content.indexOf("Settled target");
    const firstTo = firstFrom + "Settled target".length;
    const secondFrom = content.indexOf("Live target");
    const secondTo = secondFrom + "Live target".length;

    const first = await invoke<TextAnnotation>("documents:create-annotation", {
      path: filePath,
      from: firstFrom,
      to: firstTo,
      instruction: "settled thread",
      expectedAnnotationGeneration: 0,
    });
    await invoke<TextAnnotation>("documents:create-annotation", {
      path: filePath,
      from: secondFrom,
      to: secondTo,
      instruction: "live thread",
      expectedAnnotationGeneration: 1,
    });
    await invoke<TextAnnotation | AnnotationFailure>("documents:resolve-annotation", {
      path: filePath,
      annotationId: first.annotationId,
      expectedAnnotationGeneration: 2,
    });

    const cleared = await invoke<{ deleted: TextAnnotation[] } | AnnotationFailure>(
      "documents:clear-resolved-annotations",
      { path: filePath, expectedAnnotationGeneration: 3 },
    );
    assert.ok(
      !isFailure(cleared),
      `expected the cleanup to succeed, got ${JSON.stringify(cleared)}`,
    );
    const deletedAnnotation = cleared as { deleted: TextAnnotation[] };
    assert.deepEqual(
      deletedAnnotation.deleted.map((annotation) => annotation.annotationId),
      [first.annotationId],
      "exactly the resolved annotation is deleted, the open thread survives",
    );

    const session = await invoke<{ annotations: { items: TextAnnotation[] } } | undefined>(
      "documents-provider",
      { command: "get-collaboration-session", payload: { path: filePath } },
    );
    assert.ok(session !== undefined);
    assert.equal(session.annotations.items.length, 1);
  });

  it("refuses both bulk channels for a path with no document and no sidecar", async function () {
    const neverOpened = path.join(scratch, "never-opened-bulk.md");
    const resolveResult = await invoke<{ resolved: TextAnnotation[] } | AnnotationFailure>(
      "documents:resolve-acted-annotations",
      { path: neverOpened, expectedAnnotationGeneration: 0 },
    );
    assert.ok(isFailure(resolveResult), "an unresolved path must be refused, not throw");
    assert.equal(resolveResult.code, "DOCUMENT_NOT_FOUND");

    const clearResult = await invoke<{ deleted: TextAnnotation[] } | AnnotationFailure>(
      "documents:clear-resolved-annotations",
      { path: neverOpened, expectedAnnotationGeneration: 0 },
    );
    assert.ok(isFailure(clearResult), "an unresolved path must be refused, not throw");
    assert.equal(clearResult.code, "DOCUMENT_NOT_FOUND");
  });
});
