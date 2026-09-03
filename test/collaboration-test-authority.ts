/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        A real document authority for collaboration specs
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The other side of the authority seam, implemented for
 *                  real: a CodeMirror Text buffer, a version counter, a disk
 *                  string, and the same prefix/suffix change set the document
 *                  manager builds. It is not a stand-in for the manager — it
 *                  is the smallest complete implementation of the interface
 *                  the service declares, so a spec that drives it drives the
 *                  service's real ordering against a real filesystem.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { ChangeSet, Text } from "@codemirror/state";
import type { AgentEventType } from "@dts/common/agent-api";
import type { SerializedUpdate } from "@dts/common/documents";
import { sha256Text } from "@common/util/sha256";
import serializeChangeSet from "@common/util/serialize-change-set";
import type {
  CollaborationDocumentAuthority,
  PreparedDocumentMutation,
} from "source/app/service-providers/documents/document-collaboration-application-service";

export class DocumentAuthority implements CollaborationDocumentAuthority {
  public text: Text;
  public readonly events: AgentEventType[] = [];
  /** Every broadcast the service asked for, in order. */
  public readonly broadcasts: string[] = [];
  private version = 0;
  private open = true;

  constructor(
    private diskText: string,
    private readonly documentId: string,
    private readonly documentPath: string,
  ) {
    this.text = Text.of(diskText.split("\n"));
  }

  resolveDocumentPath(documentId: string): string | undefined {
    return documentId === this.documentId && this.open ? this.documentPath : undefined;
  }

  isDocumentOpen(documentPath: string): boolean {
    return documentPath === this.documentPath && this.open;
  }

  close(): void {
    this.open = false;
  }

  reopen(): void {
    this.open = true;
  }

  setDiskText(text: string): void {
    this.diskText = text;
  }

  /** Reload the buffer from disk, the way opening a drifted file does. */
  reloadFromDisk(): void {
    this.text = Text.of(this.diskText.split("\n"));
  }

  currentDiskText(): string {
    return this.diskText;
  }

  async acquireDocument(documentId: string) {
    assert.equal(documentId, this.documentId);
    return {
      documentId,
      documentPath: this.documentPath,
      wasAlreadyLoaded: true,
    };
  }

  readWorkingText(documentId: string): string | undefined {
    return documentId === this.documentId && this.open ? this.text.toString() : undefined;
  }

  async readDiskText(documentPath: string): Promise<string> {
    assert.equal(documentPath, this.documentPath);
    return this.diskText;
  }

  readSavedDiskSha256(documentId: string): string | undefined {
    return documentId === this.documentId ? sha256Text(this.diskText) : undefined;
  }

  prepareWorkingTextReplacement(
    documentId: string,
    nextText: string,
  ): PreparedDocumentMutation {
    assert.equal(documentId, this.documentId);
    const currentText = this.text.toString();
    if (currentText === nextText) {
      return { documentId, documentPath: this.documentPath, change: undefined };
    }
    let prefix = 0;
    while (
      prefix < currentText.length &&
      prefix < nextText.length &&
      currentText[prefix] === nextText[prefix]
    ) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < currentText.length - prefix &&
      suffix < nextText.length - prefix &&
      currentText[currentText.length - suffix - 1] ===
        nextText[nextText.length - suffix - 1]
    ) {
      suffix += 1;
    }
    const changes = ChangeSet.of(
      [
        {
          from: prefix,
          to: currentText.length - suffix,
          insert: nextText.slice(prefix, nextText.length - suffix),
        },
      ],
      this.text.length,
    );
    const update: SerializedUpdate = {
      changes: serializeChangeSet(changes),
      clientID: "collaboration-service-test",
    };
    return {
      documentId,
      documentPath: this.documentPath,
      change: {
        changes,
        update,
        nextText: Text.of(nextText.split("\n")),
        nextVersion: this.version + 1,
      },
    };
  }

  commitWorkingTextReplacement(prepared: PreparedDocumentMutation): void {
    if (prepared.change === undefined) {
      return;
    }
    this.text = prepared.change.nextText;
    this.version = prepared.change.nextVersion;
  }

  /**
   * Apply an owner edit the way the editor does: build the change set, apply
   * it to the buffer, and hand the service both halves.
   */
  ownerEdit(spec: { from: number; to: number; insert: string }): {
    changes: ChangeSet;
    nextText: string;
    commit: () => void;
  } {
    const changes = ChangeSet.of([spec], this.text.length);
    const nextText = changes.apply(this.text);
    return {
      changes,
      nextText: nextText.toString(),
      commit: () => {
        this.text = nextText;
        this.version += 1;
      },
    };
  }

  async releaseTemporaryDocument(documentId: string): Promise<void> {
    assert.equal(documentId, this.documentId);
  }

  broadcastCollaborationState(documentId: string): void {
    assert.equal(documentId, this.documentId);
    this.broadcasts.push("state");
  }

  broadcastReviewCleared(documentId: string, reviewId: string): void {
    assert.equal(documentId, this.documentId);
    assert.ok(reviewId.length > 0);
    this.broadcasts.push("cleared");
  }
}
