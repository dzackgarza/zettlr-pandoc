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
 *                  files, and delete the journal only after full success.
 *                  Any failure after the journal exists rolls every mutated
 *                  buffer and every installed file back to its recorded
 *                  original, and the journal survives a rollback that itself
 *                  fails so recoverWorkspaceEditJournal() can finish the job
 *                  at the next startup.
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
import type { SaveFileResult } from "@dts/common/documents";
import type { WorkspaceTextEdit } from "@dts/common/references";
import { randomUUID } from "crypto";
import { diffChars } from "diff";
import { readFile, unlink } from "fs/promises";
import path from "path";
import writeFileAtomic from "write-file-atomic";

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

/** One document's pre- and post-transaction text. */
interface JournaledDocument {
  documentPath: string;
  original: string;
  target: string;
}

/**
 * The on-disk journal. `phase` records how far the transaction got, so a
 * journal found at startup is unambiguous: 'installing' means files may hold
 * either text, 'rollback' means a rollback was interrupted. Recovery restores
 * the originals in both cases.
 */
interface WorkspaceEditJournal {
  transactionId: string;
  phase: "installing" | "rollback";
  closedFiles: JournaledDocument[];
  openBuffers: JournaledDocument[];
}

/**
 * Applies one document's edits through a CodeMirror ChangeSet — the same
 * primitive the document authority applies to live buffers, so the closed-file
 * target and the open-buffer target are computed by one implementation.
 *
 * @param   {string}               source  The document source
 * @param   {WorkspaceTextEdit[]}  edits   That document's edits
 *
 * @return  {string}                       The target text
 */
function computeTarget(source: string, edits: WorkspaceTextEdit[]): string {
  return changeSetOf(source, edits)
    .apply(Text.of(source.split("\n")))
    .toString();
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
 * The edits that take a live buffer from `current` back to `original`
 * without the text that the author typed after the transaction. The buffer
 * held the target of `edits`, and then the changes of its author: the
 * inverse of `edits` is mapped over those changes, as an editor rebases a
 * change over a concurrent one. Each edit changes only the text that the
 * transaction changed, so the typed text, the review and the annotations of
 * the document keep their places through a rollback.
 */
function restoringEdits(
  entry: JournaledDocument,
  current: string,
  edits: WorkspaceTextEdit[],
): WorkspaceTextEdit[] {
  const inverse = changeSetOf(entry.original, edits).invert(Text.of(entry.original.split("\n")));
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
    const target = computeTarget(source, editsFor(documentPath));
    journaled.push({ documentPath, original: source, target });
    resultingHashes[documentPath] = hashDocumentSource(target);
  }

  const closedFiles = journaled.filter((document) => !openPaths.includes(document.documentPath));
  const closedPaths = closedFiles.map((document) => document.documentPath);
  const journalFile = path.join(journalDirectory, JOURNAL_FILE);
  const journal: WorkspaceEditJournal = {
    transactionId: randomUUID(),
    phase: "installing",
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
      await writeFileAtomic(documentPath, target, "utf-8");
      installed.push(documentPath);
    }
  } catch (err) {
    await rollback(authority, journalFile, journal, installed, verified, input.edits);
    throw err;
  }

  await unlink(journalFile);

  return {
    status: "applied",
    closedFilesWritten: closedPaths,
    openBuffersUpdated,
    resultingHashes,
  };
}

/**
 * Restores every mutated buffer and every installed file to its journaled
 * original. The journal is marked 'rollback' first and deleted only once the
 * restoration completed: a rollback that itself fails leaves the journal for
 * startup recovery.
 *
 * @param   {WorkspaceEditAuthority}  authority    The document authority
 * @param   {string}                  journalFile  The journal's path
 * @param   {WorkspaceEditJournal}    journal      The journal
 * @param   {string[]}                installed    Files already installed
 * @param   {Set<string>}             verified     Open buffers that held the target
 * @param   {WorkspaceTextEdit[]}     edits        The edits of the transaction
 */
async function rollback(
  authority: WorkspaceEditAuthority,
  journalFile: string,
  journal: WorkspaceEditJournal,
  installed: string[],
  verified: Set<string>,
  edits: WorkspaceTextEdit[],
): Promise<void> {
  await writeFileAtomic(journalFile, JSON.stringify({ ...journal, phase: "rollback" }), "utf-8");

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
    restoreBuffers.push(
      ...restoringEdits(
        entry,
        current,
        edits.filter((edit) => edit.documentPath === entry.documentPath),
      ),
    );
  }
  if (restoreBuffers.length > 0) {
    await authority.applyWorkspaceTextEdits(restoreBuffers);
  }

  for (const documentPath of installed) {
    const entry = journal.closedFiles.find((candidate) => candidate.documentPath === documentPath);
    if (entry !== undefined) {
      await writeFileAtomic(documentPath, entry.original, "utf-8");
    }
  }

  await unlink(journalFile);
}

/**
 * Saves the open buffers a transaction updated, so that a workspace edit
 * ends on disk for every document it touched: the transaction writes the
 * closed files itself (VS Code's Replace All saves the edited files the same
 * way).
 *
 * @param   {Function}  saveFile       The document authority's save
 * @param   {string[]}  documentPaths  The open buffers the transaction updated
 */
export async function saveUpdatedBuffers(
  saveFile: (filePath: string) => Promise<SaveFileResult>,
  documentPaths: string[],
): Promise<void> {
  for (const documentPath of documentPaths) {
    const saved = await saveFile(documentPath);
    if (!saved.ok) {
      throw new Error(
        `[Workspace Edit] Could not save ${documentPath} after the edit: ${saved.refusal.message}`,
      );
    }
  }
}

/**
 * Finishes an interrupted transaction at startup: every file the journal
 * names is restored to its pre-transaction content, and the journal is
 * removed. Open buffers need no restoration — a crash discards them, and the
 * transaction never wrote their files.
 *
 * @param   {string}              journalDirectory  Application data directory
 *
 * @return  {Promise<string[]>}                     The restored file paths
 */
export async function recoverWorkspaceEditJournal(journalDirectory: string): Promise<string[]> {
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
    const current = await readFile(entry.documentPath, "utf-8").catch(() => undefined);
    if (current !== entry.original) {
      await writeFileAtomic(entry.documentPath, entry.original, "utf-8");
      restored.push(entry.documentPath);
    }
  }

  await unlink(journalFile);
  return restored;
}
