/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The journaled workspace-edit transaction
 * CVM-Role:        Utility
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     One coordinator for every workspace text transaction —
 *                  the rename commit and its inverse undo run the same code
 *                  path with different edits.
 *
 *                  The sequence is fixed: resolve open-buffer vs closed-file
 *                  ownership, read every source, verify EVERY hash before
 *                  mutating anything, compute every target, write the
 *                  journal, apply the open buffers, install the closed
 *                  files, and remove the journal. The removal of the journal
 *                  is the commit: a transaction that cannot remove its
 *                  journal did not happen, and rolls every mutated buffer
 *                  and every installed file back to its recorded original.
 *                  A journal that stays (a rollback that failed, a stop of
 *                  the app) is finished by recoverWorkspaceEditJournal() at
 *                  the next startup, which restores only a file that holds
 *                  the text that the transaction wrote.
 *
 *                  write-file-atomic owns the file-write mechanics (temp
 *                  file, fsync, rename) for both the journal and the
 *                  installed files. The coordination across several files
 *                  plus live CodeMirror buffers is application-owned because
 *                  no dependency can make that one atomic resource.
 *
 * END HEADER
 */

import { ChangeSet, Text } from "@codemirror/state";
import { hashDocumentSource } from "@common/pandoc-util/extract-references";
import isErrnoException from "@common/util/is-errno-exception";
import { editedText } from "@common/util/workspace-edit-preview";
import type { SaveFileResult, UnsavedDocument } from "@dts/common/documents";
import type { WorkspaceTextEdit } from "@dts/common/references";
import { randomUUID } from "crypto";
import { diffChars } from "diff";
import { readFile, unlink } from "fs/promises";
import path from "path";
import writeFileAtomic from "write-file-atomic";
import { systemErrorCause } from "../../util/system-error-cause";
import { writeTextFile } from "../fsal/util/write-text-file";

/** The one journal file; a workspace transaction is never concurrent. */
const JOURNAL_FILE = "workspace-edit-journal.json";

/** The input of one transaction: the edits and the fence they apply under. */
export interface WorkspaceEditTransactionInput {
  edits: WorkspaceTextEdit[];
  expectedSourceHashes: Record<string, string>;
}

/** The typed outcome of one transaction. */
export type WorkspaceEditTransactionResult =
  | {
      status: "applied";
      closedFilesWritten: string[];
      /** The text that the transaction wrote to each closed file */
      closedFileTexts: Record<string, string>;
      openBuffersUpdated: string[];
      resultingHashes: Record<string, string>;
    }
  | {
      status: "conflict";
      documentPath: string;
      expectedSourceHash: string;
      actualSourceHash: string;
    };

/**
 * The slice of the document authority a transaction drives: the open set and
 * text of every live markdown buffer, and the acknowledged application of
 * open-buffer edits.
 */
export interface WorkspaceEditAuthority {
  readMarkdownBufferContent: (filePath: string) => string | undefined;
  applyWorkspaceTextEdits: (edits: WorkspaceTextEdit[]) => Promise<string[]>;
}

/**
 * The slice of the document authority that the startup recovery drives: the
 * collaboration state that a document keeps while it is not loaded.
 */
export interface JournalRecoveryAuthority {
  /**
   * Changes the working text in the sidecar of a document that is not
   * loaded by the changes that `restore` gives for that text, and maps the
   * anchors of its review and its annotations through them. Answers whether
   * the sidecar changed; a document without a sidecar answers false.
   */
  restoreStoredWorkingText: (
    documentPath: string,
    restore: (workingText: string) => ChangeSet,
  ) => Promise<boolean>;
}

/** One document's pre- and post-transaction text, and the edits between them. */
interface JournaledDocument {
  documentPath: string;
  original: string;
  target: string;
  edits: WorkspaceTextEdit[];
}

/**
 * The on-disk journal. It exists only while a transaction has not committed:
 * each file it names holds its original, the target of the transaction, or
 * text that the author wrote after a rollback.
 */
interface WorkspaceEditJournal {
  transactionId: string;
  closedFiles: JournaledDocument[];
  openBuffers: JournaledDocument[];
}

function changeSetOf(source: string, edits: WorkspaceTextEdit[]): ChangeSet {
  return ChangeSet.of(
    edits.map((edit) => ({ from: edit.range.from, to: edit.range.to, insert: edit.insert })),
    source.length,
  );
}

/**
 * The changes that take `before` to `after`, from a character diff (jsdiff's
 * `diffChars`, the Myers algorithm).
 */
function changesBetween(before: string, after: string): ChangeSet {
  const changes: Array<{ from: number; to?: number; insert?: string }> = [];
  let position = 0;
  for (const part of diffChars(before, after)) {
    if (part.added) {
      changes.push({ from: position, insert: part.value });
    } else if (part.removed) {
      changes.push({ from: position, to: position + part.value.length });
      position += part.value.length;
    } else {
      position += part.value.length;
    }
  }
  return ChangeSet.of(changes, before.length);
}

/**
 * The edits of the document at `documentPath` that take its text from
 * `source` to `target`: the changes of a character diff (`changesBetween`).
 * An edit that a caller computed as a new text changes only the characters
 * that differ, so the annotations and the review of an open document keep
 * their places.
 */
export function editsBetween(
  documentPath: string,
  source: string,
  target: string,
): WorkspaceTextEdit[] {
  const edits: WorkspaceTextEdit[] = [];
  changesBetween(source, target).iterChanges((from, to, _fromTarget, _toTarget, inserted) => {
    edits.push({ documentPath, range: { from, to }, insert: inserted.toString() });
  });
  return edits;
}

/**
 * The edits that take a live buffer from `current` back to `original`
 * without the text that the author typed after the transaction. The buffer
 * held the target of `edits`, and then the changes of its author: the
 * inverse of `edits` is mapped over those changes, as an editor rebases a
 * change over a concurrent one. Each edit changes only the text that the
 * transaction changed, so the typed text, the review and the annotations of
 * the document keep their places through a rollback.
 */
function restoringEdits(entry: JournaledDocument, current: string): WorkspaceTextEdit[] {
  const inverse = changeSetOf(entry.original, entry.edits).invert(
    Text.of(entry.original.split("\n")),
  );
  const restoring: WorkspaceTextEdit[] = [];
  inverse
    .map(changesBetween(entry.target, current))
    .iterChanges((from, to, _fromCurrent, _toCurrent, inserted) => {
      restoring.push({
        documentPath: entry.documentPath,
        range: { from, to },
        insert: inserted.toString(),
      });
    });
  return restoring;
}

/**
 * Runs one journaled workspace-edit transaction.
 *
 * @param   {WorkspaceEditAuthority}                 authority         The document authority
 * @param   {string}                                 journalDirectory  Application data directory
 * @param   {WorkspaceEditTransactionInput}          input             Edits and their fence
 *
 * @return  {Promise<WorkspaceEditTransactionResult>}                  The typed outcome
 */
export async function runWorkspaceEditTransaction(
  authority: WorkspaceEditAuthority,
  journalDirectory: string,
  input: WorkspaceEditTransactionInput,
): Promise<WorkspaceEditTransactionResult> {
  const documentPaths = Object.keys(input.expectedSourceHashes);
  const openPaths: string[] = [];
  const sources: Array<{ documentPath: string; source: string }> = [];

  // Resolve ownership and read every source, then verify EVERY hash before
  // anything is computed or mutated: a conflict must abort with nothing done.
  for (const documentPath of documentPaths) {
    const buffer = authority.readMarkdownBufferContent(documentPath);
    if (buffer !== undefined) {
      openPaths.push(documentPath);
      sources.push({ documentPath, source: buffer });
    } else {
      sources.push({ documentPath, source: await readFile(documentPath, "utf-8") });
    }
  }

  for (const { documentPath, source } of sources) {
    const expected = input.expectedSourceHashes[documentPath];
    const actual = hashDocumentSource(source);
    if (actual !== expected) {
      return {
        status: "conflict",
        documentPath,
        expectedSourceHash: expected,
        actualSourceHash: actual,
      };
    }
  }

  // Compute and stage every target — both partitions — before mutating.
  const editsFor = (documentPath: string): WorkspaceTextEdit[] =>
    input.edits.filter((edit) => edit.documentPath === documentPath);
  const journaled: JournaledDocument[] = [];
  const resultingHashes: Record<string, string> = {};
  for (const { documentPath, source } of sources) {
    const edits = editsFor(documentPath);
    const target = editedText(source, edits);
    journaled.push({ documentPath, original: source, target, edits });
    resultingHashes[documentPath] = hashDocumentSource(target);
  }

  const closedFiles = journaled.filter((document) => !openPaths.includes(document.documentPath));
  const closedPaths = closedFiles.map((document) => document.documentPath);
  const journalFile = path.join(journalDirectory, JOURNAL_FILE);
  const journal: WorkspaceEditJournal = {
    transactionId: randomUUID(),
    closedFiles,
    openBuffers: journaled.filter((document) => openPaths.includes(document.documentPath)),
  };
  await writeFileAtomic(journalFile, JSON.stringify(journal), "utf-8");

  const installed: string[] = [];
  // The open buffers that held the target of the transaction when it
  // checked them; later text in such a buffer is text of its author.
  const verified = new Set<string>();
  let openBuffersUpdated: string[] = [];
  try {
    // The authority prepares every ChangeSet before it mutates any buffer and
    // resolves only once every named path is updated; its acknowledgement is
    // therefore the open-buffer half of this transaction.
    if (openPaths.length > 0) {
      openBuffersUpdated = await authority.applyWorkspaceTextEdits(
        input.edits.filter((edit) => openPaths.includes(edit.documentPath)),
      );
      const acknowledged = new Set(openBuffersUpdated);
      for (const documentPath of openPaths) {
        if (!acknowledged.has(documentPath)) {
          throw new Error(
            `workspace-edit: the document authority did not acknowledge ${documentPath}`,
          );
        }
        const applied = authority.readMarkdownBufferContent(documentPath);
        if (
          applied === undefined ||
          hashDocumentSource(applied) !== resultingHashes[documentPath]
        ) {
          throw new Error(
            `workspace-edit: the document authority holds different content for ${documentPath}`,
          );
        }
        verified.add(documentPath);
      }
    }

    for (const { documentPath, target } of closedFiles) {
      await writeTextFile(documentPath, target).catch((failure: NodeJS.ErrnoException) => {
        throw new Error(`Could not write ${documentPath}: ${systemErrorCause(failure)}.`, {
          cause: failure,
        });
      });
      installed.push(documentPath);
    }

    await unlink(journalFile).catch((failure: NodeJS.ErrnoException) => {
      throw new Error(
        `Could not remove the workspace edit journal ${journalFile}: ${systemErrorCause(failure)}.`,
        { cause: failure },
      );
    });
  } catch (err) {
    await rollback(authority, journalFile, journal, installed, verified).catch(
      (rollbackFailure: Error) => {
        throw new AggregateError(
          [err, rollbackFailure],
          `${String(err)} The rollback did not finish: ${rollbackFailure.message} The next start restores the documents.`,
        );
      },
    );
    throw err;
  }

  return {
    status: "applied",
    closedFilesWritten: closedPaths,
    closedFileTexts: Object.fromEntries(
      closedFiles.map((document) => [document.documentPath, document.target]),
    ),
    openBuffersUpdated,
    resultingHashes,
  };
}

/**
 * Restores every mutated buffer and every installed file to its journaled
 * original, and then removes the journal. A rollback that fails leaves the
 * journal for the recovery at the next start; a restored file holds its
 * original, which that recovery does not change.
 *
 * @param   {WorkspaceEditAuthority}  authority    The document authority
 * @param   {string}                  journalFile  The journal's path
 * @param   {WorkspaceEditJournal}    journal      The journal
 * @param   {string[]}                installed    Files already installed
 * @param   {Set<string>}             verified     Open buffers that held the target
 */
async function rollback(
  authority: WorkspaceEditAuthority,
  journalFile: string,
  journal: WorkspaceEditJournal,
  installed: string[],
  verified: Set<string>,
): Promise<void> {
  const restoreBuffers: WorkspaceTextEdit[] = [];
  for (const entry of journal.openBuffers) {
    const current = authority.readMarkdownBufferContent(entry.documentPath);
    if (current === undefined || current === entry.original) {
      continue;
    }
    // A buffer that the authority did not take to the target holds no text
    // of its author: only the whole original restores it.
    if (!verified.has(entry.documentPath)) {
      restoreBuffers.push({
        documentPath: entry.documentPath,
        range: { from: 0, to: current.length },
        insert: entry.original,
      });
      continue;
    }
    restoreBuffers.push(...restoringEdits(entry, current));
  }
  if (restoreBuffers.length > 0) {
    await authority.applyWorkspaceTextEdits(restoreBuffers);
  }

  for (const documentPath of installed) {
    const entry = journal.closedFiles.find((candidate) => candidate.documentPath === documentPath);
    if (entry !== undefined) {
      await writeTextFile(documentPath, entry.original);
    }
  }

  await unlink(journalFile).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") {
      throw new Error(
        `Could not remove the workspace edit journal ${journalFile}: ${systemErrorCause(err)}.`,
        { cause: err },
      );
    }
  });
}

/**
 * Saves the open buffers a transaction updated, so that a workspace edit
 * ends on disk for every document it touched: the transaction writes the
 * closed files itself (VS Code's Replace All saves the edited files the same
 * way). Each buffer is saved: a refused save leaves its document with the
 * edit and does not stop the saves of the others.
 *
 * @param   {Function}  saveFile       The document authority's save
 * @param   {string[]}  documentPaths  The open buffers the transaction updated
 *
 * @return  {Promise<UnsavedDocument[]>}  Each document whose save was refused
 */
export async function saveUpdatedBuffers(
  saveFile: (filePath: string) => Promise<SaveFileResult>,
  documentPaths: string[],
): Promise<UnsavedDocument[]> {
  const unsaved: UnsavedDocument[] = [];
  for (const documentPath of documentPaths) {
    const saved = await saveFile(documentPath);
    if (!saved.ok) {
      unsaved.push({ documentPath, refusal: saved.refusal });
    }
  }
  return unsaved;
}

/**
 * Finishes an interrupted transaction at startup, before a document loads:
 * each closed file that holds the target of the transaction gets its
 * original again, and the journal is removed. A file with other text (its
 * original, or text that the author wrote after a rollback that could not
 * remove the journal) and a file that is gone stay as they are: the
 * transaction writes a file in one rename, so it never removes one. A stop discards the open buffers, and
 * the transaction never wrote their files; but the collaboration service
 * wrote the edit of each buffer with a review or annotations to its sidecar,
 * and the next load restores that working text. The recovery therefore
 * takes the edit out of each such sidecar, as a rollback takes it out of a
 * live buffer, and maps the anchors back with it.
 *
 * @param   {string}                    journalDirectory  Application data directory
 * @param   {JournalRecoveryAuthority}  authority         The document authority
 *
 * @return  {Promise<string[]>}  The restored files and sidecars, by document path
 */
export async function recoverWorkspaceEditJournal(
  journalDirectory: string,
  authority: JournalRecoveryAuthority,
): Promise<string[]> {
  const journalFile = path.join(journalDirectory, JOURNAL_FILE);
  let journal: WorkspaceEditJournal;
  try {
    journal = JSON.parse(await readFile(journalFile, "utf-8")) as WorkspaceEditJournal;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return []; // The usual case: the last transaction completed
    }
    throw err;
  }

  const restored: string[] = [];
  for (const entry of journal.closedFiles) {
    const current = await readFile(entry.documentPath, "utf-8").catch((error: unknown) => {
      // Each failure but a removed file stops the recovery.
      if (isErrnoException(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (current === entry.target && current !== entry.original) {
      await writeTextFile(entry.documentPath, entry.original);
      restored.push(entry.documentPath);
    }
  }

  // A working text other than the original holds the edit of the
  // transaction: the buffer held the original when the transaction checked
  // it, and a buffer that changed before its edit refuses the edit.
  for (const entry of journal.openBuffers) {
    const changed = await authority.restoreStoredWorkingText(entry.documentPath, (workingText) =>
      workingText === entry.original
        ? ChangeSet.empty(workingText.length)
        : changeSetOf(workingText, restoringEdits(entry, workingText)),
    );
    if (changed) {
      restored.push(entry.documentPath);
    }
  }

  await unlink(journalFile);
  return restored;
}
