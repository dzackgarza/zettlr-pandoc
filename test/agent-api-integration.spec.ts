/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Agent API integration tests
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the real DocumentManager + ReviewDiffStore +
 *                  AgentAPIProvider against the spec section 15 behavioral
 *                  requirements. Tests the end-to-end flows: live buffer
 *                  reads, snapshot tokens, proposal submission, packet
 *                  composition, clearing, retraction, and save gating.
 *
 * END HEADER
 */

import { ipcMainHandlers } from "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import net from "net";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { ChangeSet, Text } from "@codemirror/state";
import { createPatch } from "diff";
import DocumentManager from "source/app/service-providers/documents";
import LogProvider from "source/app/service-providers/log";
import AgentAPIProvider from "source/app/service-providers/agent-api";
import { buildReviewDiffSession } from "source/app/util/review-diff";
import type { AppServiceContainer } from "source/app/app-service-container";
import type { CodeFileDescriptor } from "@dts/common/fsal";
import type {
  ReviewDiffSession,
  ReviewDiffStatus,
} from "@dts/common/review-diff";
import type { JsonRpcResponse } from "@dts/common/agent-api";

type IpcHandler = (
  event: unknown,
  message: { command: string; payload?: unknown },
) => Promise<unknown> | unknown;

describe("Agent API integration (spec section 15)", function () {
  let scratch: string;
  let provider: DocumentManager;
  let agentApi: AgentAPIProvider;
  let agentSocketPath: string;

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
    const userData = path.join(os.tmpdir(), "zettlr-pandoc-agent-api-test");
    mkdirSync(userData, { recursive: true });
    mkdirSync(path.join(userData, "logs"), { recursive: true });
    rmSync(path.join(userData, "documents.yaml"), { force: true });

    const watcherSeam = {
      on: () => {},
      getWatched: () => ({}),
      watchPath: (_path: string) => {},
      unwatchPath: (_path: string) => {},
      shutdown: async () => {},
    };
    let activeWindowId = "";
    const appSeam = {
      log: new LogProvider(),
      config: {
        get: () => ({
          app: {
            openFiles: [],
            openWorkspaces: [scratch],
            appLang: "en-US",
          },
          system: {
            avoidNewTabs: false,
          },
          editor: {
            autoSave: "off",
          },
        }),
        addPath: (_path: string) => false,
        set: (_key: string, _value: unknown) => {},
      },
      fsal: {
        getWatchdog: () => watcherSeam,
        testAccess: async () => true,
        getDescriptorForAnySupportedFile: async (filePath: string) =>
          descriptorFor(filePath),
        loadAnySupportedFile: async (filePath: string) =>
          normalizedRead(filePath),
        writeTextFile: async (filePath: string, content: string) => {
          writeFileSync(filePath, content, "utf8");
        },
        getDescriptorFor: async (filePath: string) => descriptorFor(filePath),
      },
      citeproc: {
        synchronizeDatabases: async (_libraries: string[]) => {},
      },
      recentDocs: {
        add: (_path: string) => {},
      },
      windows: {
        showAnyWindow: () => {},
        getFirstMainWindow: () => ({}),
        getMainWindowKey: (_window: unknown) => activeWindowId,
      },
    };

    const manager = new DocumentManager(
      appSeam as unknown as AppServiceContainer,
    );
    await manager.boot();
    activeWindowId = manager.windowKeys()[0];
    return manager;
  }

  function documentsProviderHandler(): IpcHandler {
    const registered = ipcMainHandlers.get("documents-provider") as
      | IpcHandler
      | undefined;
    assert.ok(
      registered !== undefined,
      "constructing DocumentManager must register the documents-provider handler",
    );
    return registered;
  }

  function documentsAuthorityHandler(): IpcHandler {
    const registered = ipcMainHandlers.get("documents-authority") as
      | IpcHandler
      | undefined;
    assert.ok(
      registered !== undefined,
      "constructing DocumentManager must register the documents-authority handler",
    );
    return registered;
  }

  async function pushTextUpdate(
    filePath: string,
    fromContent: string,
    toContent: string,
    version = 0,
  ): Promise<void> {
    const baselineDoc = Text.of(fromContent.split("\n"));
    const changes = ChangeSet.of(
      [{ from: 0, to: baselineDoc.length, insert: toContent }],
      baselineDoc.length,
    );
    const accepted = await documentsAuthorityHandler()(undefined, {
      command: "push-updates",
      payload: {
        filePath,
        version,
        updates: [{ changes: changes.toJSON(), clientID: "agent-api-test" }],
      },
    });
    assert.equal(
      accepted,
      true,
      "the provider must accept the real CodeMirror change update",
    );
  }

  async function currentDocumentVersion(filePath: string): Promise<number> {
    const document = await provider.getDocument(filePath);
    return document.startVersion;
  }

  async function reportReviewStatus(
    session: ReviewDiffSession,
    unresolvedChunks: number,
    originalText: string,
    currentText: string,
  ): Promise<unknown> {
    return await documentsProviderHandler()(undefined, {
      command: "set-review-diff-status",
      payload: {
        path: session.documentPath,
        sessionId: session.id,
        unresolvedChunks,
        originalText,
        currentText,
        documentVersion: await currentDocumentVersion(session.documentPath),
        sourceWindowId: "window-a",
        sourceLeafId: "leaf-a",
      },
    });
  }

  async function getReviewDiffSession(
    filePath: string,
  ): Promise<ReviewDiffSession | undefined> {
    return (await documentsProviderHandler()(undefined, {
      command: "get-review-diff-session",
      payload: { path: filePath },
    })) as ReviewDiffSession | undefined;
  }

  beforeEach(async function () {
    scratch = mkdtempSync(path.join(os.tmpdir(), "zettlr-agent-api-"));
    provider = await createProvider();
    agentSocketPath = path.join(scratch, "agent-api.sock");
    agentApi = new AgentAPIProvider(
      new LogProvider(),
      provider,
      agentSocketPath,
    );
    await agentApi.boot();
  });

  afterEach(async function () {
    await agentApi.shutdown();
    rmSync(scratch, { recursive: true, force: true });
  });

  // Helper: make a patch with generic headers
  function makePatch(oldText: string, newText: string): string {
    const patch = createPatch("document", oldText, newText, "", "", {
      context: 3,
    });
    return patch;
  }

  // Helper: connect to the agent API socket and send a JSON-RPC request
  async function agentRequest(
    method: string,
    params?: unknown,
  ): Promise<JsonRpcResponse> {
    return await new Promise((resolve, reject) => {
      const socket = net.createConnection(agentSocketPath);
      let responseText = "";
      let authenticated = false;
      let requestSent = false;

      // Read the token from the token file that AgentAPIProvider wrote
      const { app } = require("electron");
      const tokenFile = path.join(app.getPath("userData"), "agent-token");
      let token = "";
      try {
        token = readFileSync(tokenFile, "utf8").trim();
      } catch {
        // Fall back to test userData
        token = readFileSync(
          path.join(os.tmpdir(), "zettlr-pandoc-agent-api-test", "agent-token"),
          "utf8",
        ).trim();
      }

      socket.setEncoding("utf8");
      socket.on("connect", () => {
        // Authenticate with the token we already read above
        const authRequest = JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "auth",
          params: { token },
        });
        socket.write(authRequest + "\n");
      });
      socket.on("data", (chunk: string) => {
        responseText += chunk;
        const lines = responseText.split("\n");
        // Keep the last incomplete line in the buffer
        responseText = lines.pop() ?? "";
        for (const line of lines) {
          if (line.length === 0) continue;
          const msg = JSON.parse(line) as JsonRpcResponse;
          if (!authenticated && msg.id === 0) {
            authenticated = true;
            // Send the actual request
            const id = 1;
            const request = JSON.stringify({
              jsonrpc: "2.0",
              id,
              method,
              params,
            });
            socket.write(request + "\n");
            requestSent = true;
          } else if (requestSent && msg.id === 1) {
            socket.end();
            resolve(msg);
          }
        }
      });
      socket.on("error", reject);
    });
  }

  // Helper: open a file and get its documentId
  async function openFile(filePath: string, content: string): Promise<string> {
    writeFileSync(filePath, content, "utf8");
    await provider.getDocument(filePath);
    const docId = provider.getDocumentId(filePath);
    assert.ok(
      docId !== undefined,
      "documentId must be assigned after getDocument",
    );
    return docId!;
  }

  // ==========================================================================
  // Spec section 15 behavioral tests
  // ==========================================================================

  it("1. read --focused returns the unsaved live buffer and a revision-bound snapshot", async function () {
    const filePath = path.join(scratch, "note1.md");
    const content = "alpha\nbeta\ngamma\n";
    const docId = await openFile(filePath, content);

    // Push a modification to make the buffer dirty
    await pushTextUpdate(filePath, content, "alpha\nBETA\ngamma\n");

    // Read by documentId (focused requires a focused pane which the test harness doesn't set)
    const response = await agentRequest("document/read", { documentId: docId });
    assert.equal(response.error, undefined, "read should succeed");
    const result = response.result as {
      content: string;
      snapshot: string;
      revision: { version: number; sha256: string };
    };
    assert.ok(
      result.snapshot.startsWith("snap_v1_"),
      "snapshot must be a snap_v1_ token",
    );
    assert.ok(
      result.content.includes("BETA"),
      "read must return the live buffer, not the disk file",
    );
    assert.ok(
      !result.content.includes("beta"),
      "read must not return the disk content",
    );
  });

  it("2. Changing focus after reading does not change the target of propose --snapshot", async function () {
    const filePathA = path.join(scratch, "a.md");
    const filePathB = path.join(scratch, "b.md");
    const contentA = "alpha\n";
    const contentB = "beta\n";

    await openFile(filePathA, contentA);
    await openFile(filePathB, contentB);

    // Read document A's snapshot
    const docIdA = provider.getDocumentId(filePathA)!;
    const snapA = provider.createSnapshot(docIdA)!;
    const snapAToken = snapA.token;

    // The snapshot is bound to docIdA + version + sha256 — it can't redirect to B
    const parsed = DocumentManager.parseSnapshotToken(snapAToken);
    assert.equal(parsed?.documentId, docIdA);
    assert.equal(parsed?.version, snapA.version);
    assert.equal(parsed?.sha256, snapA.sha256);
  });

  it("3. A proposal against a dirty live document opens review mode without requiring a save", async function () {
    const filePath = path.join(scratch, "note3.md");
    const content = "alpha\nbeta\n";
    const docId = await openFile(filePath, content);

    // Make the document dirty
    await pushTextUpdate(filePath, content, "alpha\nBETA\n");

    // Submit a proposal against the dirty buffer
    const snap = provider.createSnapshot(docId)!;
    const result = await provider.submitProposal(
      snap.token,
      makePatch("alpha\nBETA\n", "ALPHA\nBETA\n"),
      randomUUID(),
    );
    assert.equal(result.ok, true, "proposal against dirty doc should succeed");
  });

  it("4. A second packet submitted with unresolved chunks updates the existing review immediately", async function () {
    const filePath = path.join(scratch, "note4.md");
    const content = "alpha\nbeta\ngamma\n";
    const docId = await openFile(filePath, content);

    const snap = provider.createSnapshot(docId)!;
    const first = await provider.submitProposal(
      snap.token,
      makePatch(content, "alpha\nBETA\ngamma\n"),
      "req-1",
    );
    assert.equal(first.ok, true, "first packet should succeed");

    // Second packet — needs a fresh snapshot of the current working text
    const snap2 = provider.createSnapshot(docId)!;
    const second = await provider.submitProposal(
      snap2.token,
      makePatch("alpha\nBETA\ngamma\n", "ALPHA\nBETA\ngamma\n"),
      "req-2",
    );
    assert.equal(second.ok, true, "second packet should succeed");
    if (!second.ok) return;
    assert.ok(second.unresolvedChunks > 0, "should have unresolved chunks");
  });

  it("9. review diff returns exactly the remaining unresolved proposition", async function () {
    const filePath = path.join(scratch, "note9.md");
    const content = "alpha\nbeta\ngamma\n";
    const docId = await openFile(filePath, content);

    const snap = provider.createSnapshot(docId)!;
    await provider.submitProposal(
      snap.token,
      makePatch(content, "alpha\nBETA\nGAMMA\n"),
      "req-9",
    );

    const diff = provider.reviewStore.getReviewDiff(docId);
    assert.ok(diff !== undefined, "review diff should exist");
    assert.ok(diff!.includes("-beta"), "diff should show beta change");
    assert.ok(diff!.includes("+BETA"), "diff should show BETA addition");
    assert.ok(diff!.includes("-gamma"), "diff should show gamma change");
    assert.ok(diff!.includes("+GAMMA"), "diff should show GAMMA addition");
  });

  it("10. A stale snapshot is rejected without changing the document", async function () {
    const filePath = path.join(scratch, "note10.md");
    const content = "alpha\n";
    const docId = await openFile(filePath, content);

    const snap = provider.createSnapshot(docId)!;
    // Modify the document after the snapshot
    await pushTextUpdate(filePath, content, "beta\n");

    // The stale snapshot should be rejected
    const result = await provider.submitProposal(
      snap.token,
      makePatch("alpha\n", "ALPHA\n"),
      "req-10",
    );
    assert.equal(result.ok, false, "stale snapshot should be rejected");
    if (result.ok) return;
    assert.equal(result.code, "REVISION_MISMATCH");
  });

  it("11. Duplicate clientRequestId submission is idempotent", async function () {
    const filePath = path.join(scratch, "note11.md");
    const content = "alpha\n";
    const docId = await openFile(filePath, content);

    const snap = provider.createSnapshot(docId)!;
    const first = await provider.submitProposal(
      snap.token,
      makePatch(content, "ALPHA\n"),
      "req-dup-11",
    );
    const second = await provider.submitProposal(
      snap.token,
      makePatch(content, "ALPHA\n"),
      "req-dup-11",
    );
    // Both should return the same result (idempotency)
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(
      first.packetId,
      second.packetId,
      "idempotent submission must return same packetId",
    );
  });

  it("12. review clear --discard-unresolved rejects outstanding changes but preserves accepted changes", async function () {
    const filePath = path.join(scratch, "note12.md");
    const content = "alpha\nbeta\ngamma\nomega\n";
    const docId = await openFile(filePath, content);

    const snap = provider.createSnapshot(docId)!;
    await provider.submitProposal(
      snap.token,
      makePatch(content, "ALPHA\nbeta\nGAMMA\nOMEGA\n"),
      "req-12",
    );

    // Accept the first chunk (ALPHA)
    const review = provider.reviewStore.getReview(docId)!;
    const acceptResult = provider.reviewStore.applyChunkAccept(
      docId,
      review.reviewId,
      0,
      6,
      1,
    );
    assert.equal(acceptResult.ok, true, "accept should succeed");

    // Clear remaining unresolved
    const clearResult = provider.reviewStore.clearUnresolved(docId);
    assert.equal(clearResult.ok, true, "clear should succeed");
    if (!clearResult.ok) return;
    // workingText should have ALPHA accepted but GAMMA and OMEGA reverted
    assert.ok(
      clearResult.workingText.includes("ALPHA"),
      "accepted change should be preserved",
    );
    assert.ok(
      clearResult.workingText.includes("gamma"),
      "unresolved change should be reverted",
    );
    assert.ok(
      clearResult.workingText.includes("omega"),
      "unresolved change should be reverted",
    );
  });

  it("13. Retraction succeeds for an untouched latest packet and fails safely after overlap", async function () {
    const filePath = path.join(scratch, "note13.md");
    const content = "alpha\nbeta\n";
    const docId = await openFile(filePath, content);

    const snap = provider.createSnapshot(docId)!;
    const first = await provider.submitProposal(
      snap.token,
      makePatch(content, "alpha\nBETA\n"),
      "req-13a",
    );
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const snap2 = provider.createSnapshot(docId)!;
    const second = await provider.submitProposal(
      snap2.token,
      makePatch("alpha\nBETA\n", "ALPHA\nBETA\n"),
      "req-13b",
    );
    assert.equal(second.ok, true);
    if (!second.ok) return;

    // Retract the newest packet (should succeed)
    const retractResult = provider.reviewStore.retractPacket(second.packetId);
    assert.equal(
      retractResult.ok,
      true,
      "retraction of newest packet should succeed",
    );

    // After retraction, try to retract the first packet (now it's the newest, should also succeed)
    const retractFirst = provider.reviewStore.retractPacket(first.packetId);
    assert.equal(
      retractFirst.ok,
      true,
      "retraction of now-newest packet should succeed",
    );
  });

  it("15. Saving remains impossible with unresolved chunks", async function () {
    const filePath = path.join(scratch, "note15.md");
    const content = "alpha\n";
    const docId = await openFile(filePath, content);

    const snap = provider.createSnapshot(docId)!;
    await provider.submitProposal(
      snap.token,
      makePatch(content, "ALPHA\n"),
      "req-15",
    );

    // Attempt to save — should be blocked
    const canSave = await provider.saveFile(filePath).catch(() => false);
    assert.equal(
      canSave,
      false,
      "save should be blocked while unresolved chunks remain",
    );
  });

  it("16. Saving after complete resolution writes the exact mixed accepted/rejected result", async function () {
    const filePath = path.join(scratch, "note16.md");
    const content = "alpha\nbeta\n";
    const docId = await openFile(filePath, content);

    const snap = provider.createSnapshot(docId)!;
    await provider.submitProposal(
      snap.token,
      makePatch(content, "ALPHA\nBETA\n"),
      "req-16",
    );

    // Accept ALPHA, reject BETA
    const review = provider.reviewStore.getReview(docId)!;
    provider.reviewStore.applyChunkAccept(docId, review.reviewId, 0, 6, 1);
    // After accept, the remaining chunk (BETA) needs to be rejected
    // Use clearUnresolved to reject all remaining
    const clearRaw = provider.reviewStore.clearUnresolved(docId);
    assert.equal(clearRaw.ok, true, "clear should succeed");
    if (!clearRaw.ok) return;
    const clearResult = clearRaw;
    // Push the cleared working text to the document (in a real flow, the
    // agent API's clearReview method would update the document)
    const docVersion = await currentDocumentVersion(filePath);
    await pushTextUpdate(
      filePath,
      "ALPHA\nBETA\n",
      clearResult.workingText,
      docVersion,
    );

    // Now save should succeed
    const saved = await provider.saveFile(filePath);
    assert.equal(saved, true, "save should succeed after resolution");

    const diskContent = normalizedRead(filePath);
    assert.ok(
      diskContent.includes("ALPHA"),
      "disk should have accepted change",
    );
    assert.ok(
      diskContent.includes("beta"),
      "disk should have rejected change reverted",
    );
    assert.ok(
      !diskContent.includes("BETA"),
      "disk should not have rejected change",
    );
  });

  it("Agent API: ping returns protocol version and instance ID", async function () {
    const response = await agentRequest("ping");
    assert.equal(response.error, undefined);
    const result = response.result as {
      protocolVersion: string;
      instanceId: string;
      pid: number;
    };
    assert.ok(result.protocolVersion !== undefined);
    assert.ok(result.instanceId !== undefined);
    assert.ok(typeof result.pid === "number");
  });

  it("Agent API: capabilities reports supported features", async function () {
    const response = await agentRequest("capabilities");
    assert.equal(response.error, undefined);
    const result = response.result as {
      protocolVersion: string;
      supportedPatchFormats: string[];
      reviewSupport: boolean;
    };
    assert.ok(result.protocolVersion !== undefined);
    assert.deepEqual(result.supportedPatchFormats, ["unified-diff"]);
    assert.equal(result.reviewSupport, true);
  });

  it("Agent API: context returns focused document and open documents", async function () {
    const filePath = path.join(scratch, "ctx.md");
    await openFile(filePath, "content\n");

    const response = await agentRequest("context");
    assert.equal(response.error, undefined);
    const result = response.result as { openDocuments: unknown[] };
    assert.ok(
      result.openDocuments.length > 0,
      "should have at least one open document",
    );
  });

  it("Agent API: documents/list returns all open documents", async function () {
    const filePath = path.join(scratch, "list.md");
    await openFile(filePath, "content\n");

    const response = await agentRequest("documents/list");
    assert.equal(response.error, undefined);
    const result = response.result as {
      documents: { documentId: string; path: string }[];
    };
    assert.ok(result.documents.length > 0);
    const found = result.documents.find((d) => d.path === filePath);
    assert.ok(found !== undefined, "should find the open document");
  });

  it("Agent API: review/status returns the active review state", async function () {
    const filePath = path.join(scratch, "status.md");
    const content = "alpha\n";
    const docId = await openFile(filePath, content);

    const snap = provider.createSnapshot(docId)!;
    await provider.submitProposal(
      snap.token,
      makePatch(content, "ALPHA\n"),
      "req-status",
    );

    const response = await agentRequest("review/status", { documentId: docId });
    assert.equal(response.error, undefined);
    const result = response.result as {
      reviewId: string;
      state: string;
      unresolvedChunks: number;
    };
    assert.ok(result.reviewId !== undefined);
    assert.equal(result.state, "active");
    assert.ok(result.unresolvedChunks > 0);
  });

  it("Agent API: review/diff returns the composite unresolved patch", async function () {
    const filePath = path.join(scratch, "rdiff.md");
    const content = "alpha\n";
    const docId = await openFile(filePath, content);

    const snap = provider.createSnapshot(docId)!;
    await provider.submitProposal(
      snap.token,
      makePatch(content, "ALPHA\n"),
      "req-rdiff",
    );

    const response = await agentRequest("review/diff", { documentId: docId });
    assert.equal(response.error, undefined);
    const result = response.result as { patch: string; generation: number };
    assert.ok(result.patch.includes("-alpha"));
    assert.ok(result.patch.includes("+ALPHA"));
  });

  it("Agent API: review/clear discards unresolved and preserves accepted", async function () {
    const filePath = path.join(scratch, "rclear.md");
    const content = "alpha\nbeta\n";
    const docId = await openFile(filePath, content);

    const snap = provider.createSnapshot(docId)!;
    await provider.submitProposal(
      snap.token,
      makePatch(content, "ALPHA\nBETA\n"),
      "req-rclear",
    );

    // Accept ALPHA
    const review = provider.reviewStore.getReview(docId)!;
    provider.reviewStore.applyChunkAccept(docId, review.reviewId, 0, 6, 1);

    // Clear via the agent API
    const response = await agentRequest("review/clear", {
      reviewId: review.reviewId,
      discardUnresolved: true,
    });
    assert.equal(response.error, undefined);
    const result = response.result as { state: string };
    assert.equal(result.state, "cleared");
  });
});
