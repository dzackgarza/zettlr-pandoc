/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Workspace rename atomicity specs (issue #1, Phase 6 red)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks the ReferenceProvider rename protocol against a
 *                  SCRATCH COPY of the reference-workspace fixture on disk —
 *                  the committed fixture is never mutated. The rename
 *                  protocol is driven through the PRODUCTION command surface
 *                  (review B7): the 'application' channel's RenameReference
 *                  command ('preview-/commit-/undo-reference-rename')
 *                  delegating to the real provider — the same chain
 *                  MainEditor.vue invokes. Live-buffer plays stay on the
 *                  real 'reference-provider' ipcMain handler (their own
 *                  production path). The provider is constructed exactly
 *                  like production (LogProvider + injected FSAL seam) and
 *                  fed real FSAL event payloads whose snapshots come from
 *                  the real extractor.
 *
 *                  BOUNDARY SPLIT (stated per the red-proof contract): the
 *                  main-process provider owns hash-fencing and CLOSED-FILE
 *                  atomic disk writes. Open buffers remain unsaved, but the
 *                  DOCUMENT AUTHORITY applies their transactions and records
 *                  collab updates for every renderer pane before it
 *                  acknowledges success (issue #53). This spec exercises
 *                  that authority seam through a real mutable buffer map —
 *                  the provider's open-set partition, hash fences, live
 *                  overlay, commit, and undo all read it.
 *
 * END HEADER
 */

// biome-ignore-all assist/source/organizeImports: the harness installs the
// electron stand-in at module scope, so it has to load before any module
// that imports electron itself. Sorting these imports breaks the specs.
import { ipcMainHandlers, userData } from "./headless-electron-harness.cjs";
import type { WorkspaceReferenceEdit, WorkspaceTextEdit } from "@dts/common/references";
import { strict as assert } from "assert";
import EventEmitter from "events";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { cp, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { AppServiceContainer } from "source/app/app-service-container";
import RenameReference from "source/app/service-providers/commands/rename-reference";
import LogProvider from "source/app/service-providers/log";
import ReferenceProvider from "source/app/service-providers/references";
import type { WorkspaceReferenceState } from "source/app/service-providers/references/reference-index";
import type {
  CommitRenameOutcome,
  ReferenceRenamePreview,
  UndoRenameOutcome,
} from "source/common/pandoc-util/compute-reference-edits";
import {
  extractReferences,
  hashDocumentSource,
} from "source/common/pandoc-util/extract-references";
import type { MDFileDescriptor } from "source/types/common/fsal";
// The harness must load before any provider module: LogProvider imports
// 'electron' at module scope.

const FIXTURE_ROOT = path.join("test", "fixtures", "reference-workspace");
const RELATIVE_FILES = [
  path.join("ProjectA", "Theorems.md"),
  path.join("ProjectA", "Halphen_Surfaces.md"),
  path.join("ProjectA", "Coble_Lattice_Table.md"),
  path.join("ProjectB", "Other_Paper.md"),
  "Standalone_Notes.md",
];

const OLD_KEY = "thm:torelli";
const NEW_KEY = "thm:torelli-enriques";

type IpcInvoke = (
  event: unknown,
  message: { command: string; payload?: unknown },
) => Promise<unknown> | unknown;

/** The real registered 'reference-provider' handler, from the harness. */
function referenceHandler(): IpcInvoke {
  const handler = ipcMainHandlers.get("reference-provider") as IpcInvoke | undefined;
  assert.ok(
    handler !== undefined,
    "constructing ReferenceProvider must register the reference-provider handler",
  );
  return handler;
}

async function invoke(command: string, payload?: unknown): Promise<unknown> {
  return await referenceHandler()(undefined, { command, payload });
}

/** Builds the real markdown descriptor FSAL would emit for a scratch file. */
function makeDescriptor(documentPath: string): MDFileDescriptor {
  const content = readFileSync(documentPath, "utf-8");
  return {
    dir: path.dirname(documentPath),
    path: documentPath,
    name: path.basename(documentPath),
    ext: path.extname(documentPath),
    size: content.length,
    id: "",
    tags: [],
    links: [],
    citekeys: [],
    bom: "",
    type: "file",
    wordCount: 0,
    charCount: 0,
    modtime: 0,
    creationtime: 0,
    linefeed: "\n",
    firstHeading: null,
    yamlTitle: undefined,
    frontmatter: null,
    references: extractReferences(documentPath, content),
  };
}

/** Renderer/disk application oracle (descending by range start). */
function applyEdits(source: string, edits: WorkspaceTextEdit[]): string {
  const ordered = [...edits].sort((a, b) => b.range.from - a.range.from);
  let result = source;
  for (const edit of ordered) {
    result = result.slice(0, edit.range.from) + edit.insert + result.slice(edit.range.to);
  }
  return result;
}

/** Narrows an accepted preview, failing loudly (red) on rejection. */
function editOf(preview: ReferenceRenamePreview, label: string): WorkspaceReferenceEdit {
  assert.equal(
    preview.status,
    "ok",
    `${label}: the preview must be accepted, got ${JSON.stringify(preview)}`,
  );
  return (preview as Extract<ReferenceRenamePreview, { status: "ok" }>).edit;
}

/**
 * How the document authority fails the NEXT application it is asked for. The
 * authority is a seam the provider is constructed with, so these are the real
 * ways the real seam can betray a transaction, not a stubbed filesystem:
 *
 * - `throw`:          the authority cannot apply the edits at all
 * - `unacknowledged`: it applies them but names fewer buffers than it was given
 * - `divergent`:      it names every buffer but holds different text than the
 *                     transaction computed (a keystroke landed mid-flight)
 */
type AuthorityFault = "none" | "throw" | "unacknowledged" | "divergent";

/** One scratch workspace: fixture copy, provider, FSAL seam, live Halphen buffer. */
interface ScratchWorkspace {
  root: string;
  provider: ReferenceProvider;
  /** The real 'application'-channel command chain over this provider (B7) */
  command: RenameReference;
  /** Where this provider journals; the rollback's own application is normal. */
  journalFile: string;
  /** Consumed by the next authority application, then cleared. */
  authorityFault: { next: AuthorityFault };
  /**
   * The document authority's open buffer map behind the injected
   * readMarkdownBufferContent seam (issue #53): a path present here IS an
   * open markdown buffer with exactly this text.
   */
  authorityBuffers: Map<string, string>;
  /** Fires every pending debounced authority extraction (injected scheduler). */
  fireScheduled: () => void;
  paths: {
    theorems: string;
    halphen: string;
    coble: string;
    otherPaper: string;
    standalone: string;
  };
  /** Original on-disk bytes at setup time, by absolute scratch path */
  originals: Map<string, string>;
}

async function setUpScratchWorkspace(
  journalDirectory: string = userData,
): Promise<ScratchWorkspace> {
  const root = await mkdtemp(path.join(tmpdir(), "zettlr-reference-rename-"));
  await cp(FIXTURE_ROOT, root, { recursive: true });

  const paths = {
    theorems: path.join(root, "ProjectA", "Theorems.md"),
    halphen: path.join(root, "ProjectA", "Halphen_Surfaces.md"),
    coble: path.join(root, "ProjectA", "Coble_Lattice_Table.md"),
    otherPaper: path.join(root, "ProjectB", "Other_Paper.md"),
    standalone: path.join(root, "Standalone_Notes.md"),
  };

  const originals = new Map<string, string>();
  for (const relative of RELATIVE_FILES) {
    const absolute = path.join(root, relative);
    originals.set(absolute, readFileSync(absolute, "utf-8"));
  }

  const seam = new EventEmitter();
  const authorityBuffers = new Map<string, string>();
  const authorityFault: { next: AuthorityFault } = { next: "none" };
  const scheduled: Array<{ callback: () => void; cancelled: boolean }> = [];
  const provider = new ReferenceProvider(
    new LogProvider(),
    seam,
    {
      readMarkdownBufferContent: (filePath: string) => authorityBuffers.get(filePath),
      applyWorkspaceTextEdits: async (edits: WorkspaceTextEdit[]) => {
        const paths = [...new Set(edits.map((edit) => edit.documentPath))];
        // One fault per application: the rollback's own restoring application
        // must run normally, or the test would prove nothing about recovery.
        const fault = authorityFault.next;
        authorityFault.next = "none";
        if (fault === "throw") {
          throw new Error("the document authority could not apply the transaction");
        }
        for (const documentPath of paths) {
          const content = authorityBuffers.get(documentPath);
          assert(
            content !== undefined,
            `Workspace edit names unopened authority buffer ${documentPath}`,
          );
          authorityBuffers.set(
            documentPath,
            applyEdits(
              content,
              edits.filter((edit) => edit.documentPath === documentPath),
            ),
          );
        }
        if (fault === "divergent") {
          for (const documentPath of paths) {
            authorityBuffers.set(
              documentPath,
              `${authorityBuffers.get(documentPath) ?? ""}A keystroke that landed mid-transaction.\n`,
            );
          }
        }
        return fault === "unacknowledged" ? [] : paths;
      },
    },
    500,
    journalDirectory,
    {
      schedule: (callback: () => void, _delayMs: number) => {
        const task = { callback, cancelled: false };
        scheduled.push(task);
        return {
          cancel: () => {
            task.cancelled = true;
          },
        };
      },
    },
  );
  const fireScheduled = (): void => {
    for (const task of scheduled.splice(0)) {
      if (!task.cancelled) {
        task.callback();
      }
    }
  };
  await provider.boot();
  for (const absolute of originals.keys()) {
    seam.emit("fsal-event", { event: "change", descriptor: makeDescriptor(absolute) });
  }

  // The REAL command object CommandProvider dispatches 'application'-channel
  // rename events to, bound to this provider at the exact injection point
  // (this._app.references) — the renderer-reachable production route.
  const command = new RenameReference({ references: provider } as unknown as AppServiceContainer);

  // Halphen_Surfaces.md is OPEN in the document authority (content identical
  // to disk), and the authority reported the load (issue #53). The commit
  // must route Halphen through the authority, never through a disk write.
  authorityBuffers.set(paths.halphen, originals.get(paths.halphen) ?? "");
  provider.reportAuthorityBuffer(paths.halphen);
  fireScheduled();

  return {
    root,
    provider,
    command,
    journalFile: path.join(journalDirectory, "workspace-edit-journal.json"),
    authorityFault,
    authorityBuffers,
    fireScheduled,
    paths,
    originals,
  };
}

/** Byte-compares every workspace file against the expected content map. */
function assertWorkspaceBytes(
  scratch: ScratchWorkspace,
  expected: Map<string, string>,
  label: string,
): void {
  for (const relative of RELATIVE_FILES) {
    const absolute = path.join(scratch.root, relative);
    assert.equal(
      readFileSync(absolute, "utf-8"),
      expected.get(absolute),
      `${label}: ${relative} must match the expected bytes exactly`,
    );
  }
}

describe("Workspace rename commit protocol", function () {
  describe("conflict abort", function () {
    let scratch: ScratchWorkspace;

    before(async function () {
      scratch = await setUpScratchWorkspace();
    });

    after(async function () {
      await scratch.provider.shutdown();
      await rm(scratch.root, { recursive: true, force: true });
    });

    it("preview-reference-rename over the merged workspace computes the complete four-document edit", async function () {
      const preview = (await scratch.command.run("preview-reference-rename", {
        oldKey: OLD_KEY,
        newKey: NEW_KEY,
      })) as ReferenceRenamePreview;
      const edit = editOf(preview, "command preview-reference-rename");

      const touched = [...new Set(edit.edits.map((e) => e.documentPath))].sort();
      assert.deepEqual(
        touched,
        [
          scratch.paths.theorems,
          scratch.paths.otherPaper,
          scratch.paths.halphen,
          scratch.paths.standalone,
        ].sort(),
        "both duplicate definitions plus the cluster and bare occurrences must be edited",
      );
      assert.deepEqual(
        edit.expectedSourceHashes,
        {
          [scratch.paths.theorems]: hashDocumentSource(
            scratch.originals.get(scratch.paths.theorems) ?? "",
          ),
          [scratch.paths.otherPaper]: hashDocumentSource(
            scratch.originals.get(scratch.paths.otherPaper) ?? "",
          ),
          [scratch.paths.halphen]: hashDocumentSource(
            scratch.originals.get(scratch.paths.halphen) ?? "",
          ),
          [scratch.paths.standalone]: hashDocumentSource(
            scratch.originals.get(scratch.paths.standalone) ?? "",
          ),
        },
        "every touched document must be fenced at its current workspace content",
      );
    });

    it("commit-reference-rename aborts atomically with a structured conflict when a closed file changed on disk", async function () {
      const preview = (await scratch.command.run("preview-reference-rename", {
        oldKey: OLD_KEY,
        newKey: NEW_KEY,
      })) as ReferenceRenamePreview;
      const edit = editOf(preview, "conflict-path preview");

      // Concurrent interference: ONE closed file changes on disk after the
      // preview, with NO FSAL event — the provider's index still holds the
      // stale snapshot, so the commit must RE-READ THE DISK to notice.
      const mutated =
        (scratch.originals.get(scratch.paths.standalone) ?? "") + "\nAppended concurrent edit.\n";
      writeFileSync(scratch.paths.standalone, mutated, "utf-8");

      const expectedBytes = new Map(scratch.originals);
      expectedBytes.set(scratch.paths.standalone, mutated);

      const outcome = (await scratch.command.run("commit-reference-rename", {
        edit,
      })) as CommitRenameOutcome;
      assert.equal(
        outcome.status,
        "conflict",
        `a hash mismatch must abort the whole commit, got ${JSON.stringify(outcome)}`,
      );
      assert.deepEqual(
        outcome.status === "conflict" ? outcome.conflict : undefined,
        {
          status: "conflict",
          documentPath: scratch.paths.standalone,
          expectedSourceHash: edit.expectedSourceHashes[scratch.paths.standalone],
          actualSourceHash: hashDocumentSource(mutated),
        },
        "the conflict must name the mismatching document and both hashes",
      );

      // ATOMICITY: nothing was applied anywhere. Every file keeps its exact
      // pre-commit bytes (including the concurrent mutation itself).
      assertWorkspaceBytes(scratch, expectedBytes, "after conflicted commit");

      // No temp+rename debris either (issue #5, C9): the conflicted commit
      // leaves the workspace directories containing exactly the fixture
      // files — no staged .*.tmp artifact survives the abort.
      assert.deepEqual(readdirSync(path.join(scratch.root, "ProjectA")).sort(), [
        "Coble_Lattice_Table.md",
        "Halphen_Surfaces.md",
        "Theorems.md",
      ]);
      assert.deepEqual(readdirSync(path.join(scratch.root, "ProjectB")), ["Other_Paper.md"]);
      assert.deepEqual(readdirSync(scratch.root).sort(), [
        "ProjectA",
        "ProjectB",
        "Standalone_Notes.md",
      ]);

      // The live overlay is untouched: Halphen still serves the authority's
      // load-time content, and no transaction reached any buffer.
      const state = (await invoke("get-snapshot")) as WorkspaceReferenceState;
      const halphen = state.snapshots.find((s) => s.documentPath === scratch.paths.halphen);
      assert.equal(
        halphen?.sourceHash,
        hashDocumentSource(scratch.originals.get(scratch.paths.halphen) ?? ""),
        "a conflicted commit must leave the open buffer overlay untouched",
      );
    });
  });

  describe("applied path and one-shot undo", function () {
    let scratch: ScratchWorkspace;
    let previewedEdit: WorkspaceReferenceEdit | undefined;
    let commitOutcome: CommitRenameOutcome | undefined;

    before(async function () {
      scratch = await setUpScratchWorkspace();
    });

    after(async function () {
      await scratch.provider.shutdown();
      await rm(scratch.root, { recursive: true, force: true });
    });

    it("commit-reference-rename writes closed files atomically and acknowledges open authority buffers", async function () {
      const preview = (await scratch.command.run("preview-reference-rename", {
        oldKey: OLD_KEY,
        newKey: NEW_KEY,
      })) as ReferenceRenamePreview;
      previewedEdit = editOf(preview, "applied-path preview");

      const outcome = (await scratch.command.run("commit-reference-rename", {
        edit: previewedEdit,
      })) as CommitRenameOutcome;
      assert.equal(
        outcome.status,
        "applied",
        `the clean commit must apply, got ${JSON.stringify(outcome)}`,
      );
      commitOutcome = outcome;

      const closedPaths = [
        scratch.paths.theorems,
        scratch.paths.otherPaper,
        scratch.paths.standalone,
      ];
      assert.deepEqual(
        outcome.status === "applied" ? [...outcome.closedFilesWritten].sort() : undefined,
        [...closedPaths].sort(),
        "exactly the closed documents are written on disk; the open Halphen buffer is never a disk write",
      );

      // Closed files: byte-assert the rewritten content against the
      // renderer/disk application oracle over the previewed edits.
      const expectedBytes = new Map(scratch.originals);
      for (const closedPath of closedPaths) {
        expectedBytes.set(
          closedPath,
          applyEdits(
            scratch.originals.get(closedPath) ?? "",
            previewedEdit.edits.filter((e) => e.documentPath === closedPath),
          ),
        );
      }
      // The OPEN buffer's disk file is untouched: it stays dirty in the
      // renderer until the user saves.
      assertWorkspaceBytes(scratch, expectedBytes, "after applied commit");

      // The provider routes every open transaction through the central
      // document authority and reports the acknowledged paths.
      assert.deepEqual(
        outcome.status === "applied" ? outcome.openBuffersUpdated : undefined,
        [scratch.paths.halphen],
        "the open Halphen authority buffer must be acknowledged before success",
      );
      assert.equal(
        scratch.authorityBuffers.get(scratch.paths.halphen),
        applyEdits(
          scratch.originals.get(scratch.paths.halphen) ?? "",
          previewedEdit.edits.filter((e) => e.documentPath === scratch.paths.halphen),
        ),
        "the central authority owns the renamed open-buffer text",
      );

      // No temp+rename debris: the workspace directories contain exactly
      // the fixture files.
      assert.deepEqual(readdirSync(path.join(scratch.root, "ProjectA")).sort(), [
        "Coble_Lattice_Table.md",
        "Halphen_Surfaces.md",
        "Theorems.md",
      ]);
      assert.deepEqual(readdirSync(path.join(scratch.root, "ProjectB")), ["Other_Paper.md"]);
      assert.deepEqual(readdirSync(scratch.root).sort(), [
        "ProjectA",
        "ProjectB",
        "Standalone_Notes.md",
      ]);

      scratch.provider.reportAuthorityBuffer(scratch.paths.halphen);
      scratch.fireScheduled();
    });

    it("undo-reference-rename is hash-fenced, restores every byte, and is one-shot", async function () {
      assert.ok(
        previewedEdit !== undefined && commitOutcome?.status === "applied",
        "undo requires the applied commit from the previous spec",
      );

      const renamedTheorems = applyEdits(
        scratch.originals.get(scratch.paths.theorems) ?? "",
        previewedEdit.edits.filter((e) => e.documentPath === scratch.paths.theorems),
      );

      // Hash fence: mutate one closed file AFTER the commit; the undo must
      // abort whole with a structured conflict and consume nothing.
      const interfered = renamedTheorems + "\nPost-commit interference.\n";
      writeFileSync(scratch.paths.theorems, interfered, "utf-8");

      const conflicted = (await scratch.command.run(
        "undo-reference-rename",
        undefined,
      )) as UndoRenameOutcome;
      assert.equal(
        conflicted.status,
        "conflict",
        `an interfered undo must abort, got ${JSON.stringify(conflicted)}`,
      );
      assert.deepEqual(
        conflicted.status === "conflict" ? conflicted.conflict : undefined,
        {
          status: "conflict",
          documentPath: scratch.paths.theorems,
          expectedSourceHash: hashDocumentSource(renamedTheorems),
          actualSourceHash: hashDocumentSource(interfered),
        },
        "the undo fence must compare against the post-commit content",
      );

      // The conflicted undo leaves no temp+rename debris behind (issue #5,
      // C9): the workspace directories still contain exactly the fixture
      // files.
      assert.deepEqual(readdirSync(path.join(scratch.root, "ProjectA")).sort(), [
        "Coble_Lattice_Table.md",
        "Halphen_Surfaces.md",
        "Theorems.md",
      ]);
      assert.deepEqual(readdirSync(path.join(scratch.root, "ProjectB")), ["Other_Paper.md"]);
      assert.deepEqual(readdirSync(scratch.root).sort(), [
        "ProjectA",
        "ProjectB",
        "Standalone_Notes.md",
      ]);

      // The interference is withdrawn (the concurrent editor restores the
      // post-commit bytes); the pending undo record must have survived the
      // conflicted attempt.
      writeFileSync(scratch.paths.theorems, renamedTheorems, "utf-8");

      const applied = (await scratch.command.run(
        "undo-reference-rename",
        undefined,
      )) as UndoRenameOutcome;
      assert.equal(
        applied.status,
        "applied",
        `the clean undo must apply, got ${JSON.stringify(applied)}`,
      );
      assert.deepEqual(
        applied.status === "applied" ? [...applied.closedFilesWritten].sort() : undefined,
        [scratch.paths.theorems, scratch.paths.otherPaper, scratch.paths.standalone].sort(),
        "the undo rewrites exactly the closed files",
      );

      // Closed files return to their ORIGINAL fixture bytes; the open
      // Halphen buffer's disk file remains untouched throughout.
      assertWorkspaceBytes(scratch, scratch.originals, "after applied undo");

      assert.deepEqual(
        applied.status === "applied" ? applied.openBuffersUpdated : undefined,
        [scratch.paths.halphen],
        "the open Halphen undo must be acknowledged before undo reports success",
      );
      assert.equal(
        scratch.authorityBuffers.get(scratch.paths.halphen),
        scratch.originals.get(scratch.paths.halphen),
        "the inverse authority transaction must restore the open buffer byte-exactly",
      );
      scratch.provider.reportAuthorityBuffer(scratch.paths.halphen);
      scratch.fireScheduled();

      // One-shot: the applied undo consumed the record.
      const exhausted = (await scratch.command.run(
        "undo-reference-rename",
        undefined,
      )) as UndoRenameOutcome;
      assert.deepEqual(
        exhausted,
        { status: "no-pending-undo" },
        "a second undo has nothing left to restore",
      );
    });
  });
});

describe("Workspace edit transaction rollback and recovery", function () {
  describe("a failed file installation rolls the whole transaction back", function () {
    let scratch: ScratchWorkspace;

    before(async function () {
      scratch = await setUpScratchWorkspace();
    });

    after(async function () {
      chmodSync(path.join(scratch.root, "ProjectB"), 0o755);
      await scratch.provider.shutdown();
      await rm(scratch.root, { recursive: true, force: true });
    });

    it("restores every installed file and every mutated buffer, and leaves no journal", async function () {
      if (process.getuid?.() === 0) {
        this.skip(); // root ignores the directory permission this injection needs
      }

      const preview = (await scratch.command.run("preview-reference-rename", {
        oldKey: OLD_KEY,
        newKey: NEW_KEY,
      })) as ReferenceRenamePreview;
      const edit = editOf(preview, "rollback-path preview");

      // The transaction installs closed files in the order the edit fences
      // them, so this is what makes ProjectB a LATER installation. Asserted,
      // not assumed: were Other_Paper.md installed first, this spec would
      // silently become the empty-rollback case instead of the loaded one.
      const closedOrder = Object.keys(edit.expectedSourceHashes).filter(
        (documentPath) => documentPath !== scratch.paths.halphen,
      );
      assert.ok(
        closedOrder.indexOf(scratch.paths.otherPaper) > 0,
        `the injected failure must follow at least one installation, got ${JSON.stringify(closedOrder)}`,
      );

      // Real failure injection, no filesystem mock: ProjectB becomes
      // unwritable, so write-file-atomic cannot stage its temp file there.
      // The transaction fails with earlier installations already on disk.
      chmodSync(path.join(scratch.root, "ProjectB"), 0o555);

      await assert.rejects(
        async () => await scratch.command.run("commit-reference-rename", { edit }),
        "an installation that cannot be performed must fail loudly",
      );

      // Every file holds its original bytes again, including the ones the
      // transaction had already installed.
      assertWorkspaceBytes(scratch, scratch.originals, "after rolled-back commit");
      assert.equal(
        scratch.authorityBuffers.get(scratch.paths.halphen),
        scratch.originals.get(scratch.paths.halphen),
        "the rollback must restore the open authority buffer byte-exactly",
      );
      assert.deepEqual(readdirSync(path.join(scratch.root, "ProjectA")).sort(), [
        "Coble_Lattice_Table.md",
        "Halphen_Surfaces.md",
        "Theorems.md",
      ]);
      assert.equal(
        existsSync(path.join(userData, "workspace-edit-journal.json")),
        false,
        "a completed rollback deletes its journal",
      );

      // Nothing was recorded to undo: the failed commit never applied.
      const undone = (await scratch.command.run(
        "undo-reference-rename",
        undefined,
      )) as UndoRenameOutcome;
      assert.deepEqual(undone, { status: "no-pending-undo" });
    });
  });

  describe("a failed open-buffer commit rolls the whole transaction back", function () {
    let scratch: ScratchWorkspace;

    before(async function () {
      scratch = await setUpScratchWorkspace();
    });

    after(async function () {
      await scratch.provider.shutdown();
      await rm(scratch.root, { recursive: true, force: true });
    });

    it("leaves every closed file untouched when the authority cannot apply the open buffers", async function () {
      const preview = (await scratch.command.run("preview-reference-rename", {
        oldKey: OLD_KEY,
        newKey: NEW_KEY,
      })) as ReferenceRenamePreview;
      const edit = editOf(preview, "authority-failure preview");

      scratch.authorityFault.next = "throw";
      await assert.rejects(
        async () => await scratch.command.run("commit-reference-rename", { edit }),
        "an open-buffer application the authority refuses must fail loudly",
      );

      // The open buffers are the transaction's FIRST mutation, so a closed
      // file holding renamed bytes here means the installations ran before
      // the half that just failed.
      assertWorkspaceBytes(scratch, scratch.originals, "after a refused open-buffer commit");
      assert.equal(
        scratch.authorityBuffers.get(scratch.paths.halphen),
        scratch.originals.get(scratch.paths.halphen),
        "the open buffer must hold its pre-transaction text",
      );
      assert.equal(
        existsSync(scratch.journalFile),
        false,
        "a completed rollback deletes its journal",
      );

      const undone = (await scratch.command.run(
        "undo-reference-rename",
        undefined,
      )) as UndoRenameOutcome;
      assert.deepEqual(
        undone,
        { status: "no-pending-undo" },
        "a failed commit records nothing to undo",
      );
    });
  });

  describe("an open-buffer application the authority did not truly perform", function () {
    const workspaces: ScratchWorkspace[] = [];

    after(async function () {
      for (const scratch of workspaces) {
        await scratch.provider.shutdown();
        await rm(scratch.root, { recursive: true, force: true });
      }
    });

    // Two distinct betrayals, each with its own refusal in the transaction:
    // the acknowledgement list is short, or the text behind it is not the
    // text the transaction computed. Without both checks a commit reports
    // success while the user's open pane holds something else entirely.
    const cases = [
      {
        fault: "unacknowledged" as const,
        title: "names fewer buffers than the transaction handed it",
      },
      {
        fault: "divergent" as const,
        title: "holds different content than the transaction computed",
      },
    ];

    for (const { fault, title } of cases) {
      it(`rolls back when the authority ${title}`, async function () {
        const scratch = await setUpScratchWorkspace();
        workspaces.push(scratch);

        const preview = (await scratch.command.run("preview-reference-rename", {
          oldKey: OLD_KEY,
          newKey: NEW_KEY,
        })) as ReferenceRenamePreview;
        const edit = editOf(preview, `${fault} preview`);

        scratch.authorityFault.next = fault;
        await assert.rejects(
          async () => await scratch.command.run("commit-reference-rename", { edit }),
          `${fault}: an unverified open-buffer application must not be reported as applied`,
        );

        assertWorkspaceBytes(scratch, scratch.originals, `after a ${fault} commit`);
        assert.equal(
          scratch.authorityBuffers.get(scratch.paths.halphen),
          scratch.originals.get(scratch.paths.halphen),
          `${fault}: the rollback must restore the mutated buffer byte-exactly`,
        );
        assert.equal(
          existsSync(scratch.journalFile),
          false,
          `${fault}: a completed rollback deletes its journal`,
        );

        const undone = (await scratch.command.run(
          "undo-reference-rename",
          undefined,
        )) as UndoRenameOutcome;
        assert.deepEqual(undone, { status: "no-pending-undo" });
      });
    }
  });

  describe("the journal is written before anything is mutated", function () {
    let scratch: ScratchWorkspace;
    let journalDirectory: string;

    before(async function () {
      journalDirectory = await mkdtemp(path.join(tmpdir(), "zettlr-reference-journal-dir-"));
      scratch = await setUpScratchWorkspace(journalDirectory);
    });

    after(async function () {
      chmodSync(journalDirectory, 0o755);
      await scratch.provider.shutdown();
      await rm(scratch.root, { recursive: true, force: true });
      await rm(journalDirectory, { recursive: true, force: true });
    });

    it("mutates nothing when the journal cannot be written", async function () {
      if (process.getuid?.() === 0) {
        this.skip(); // root ignores the directory permission this injection needs
      }

      const preview = (await scratch.command.run("preview-reference-rename", {
        oldKey: OLD_KEY,
        newKey: NEW_KEY,
      })) as ReferenceRenamePreview;
      const edit = editOf(preview, "journal-failure preview");

      // The journal is the only thing standing between a crash mid-install
      // and an unrecoverable workspace. A transaction that mutates before it
      // exists cannot be recovered at the next startup, so the write has to
      // come first — and its failure has to abort the whole commit.
      chmodSync(journalDirectory, 0o555);

      await assert.rejects(
        async () => await scratch.command.run("commit-reference-rename", { edit }),
        "a transaction that cannot journal must fail loudly",
      );

      assertWorkspaceBytes(scratch, scratch.originals, "after a commit that could not journal");
      assert.equal(
        scratch.authorityBuffers.get(scratch.paths.halphen),
        scratch.originals.get(scratch.paths.halphen),
        "no buffer may be mutated before the journal exists",
      );
      assert.deepEqual(
        readdirSync(journalDirectory),
        [],
        "the failed journal write leaves nothing behind",
      );
    });
  });

  describe("a journal found at startup restores the pre-transaction state", function () {
    let root: string;
    let provider: ReferenceProvider;

    after(async function () {
      await provider.shutdown();
      await rm(root, { recursive: true, force: true });
      await rm(path.join(userData, "workspace-edit-journal.json"), { force: true });
    });

    it("rewrites every journaled file to its original content and deletes the journal", async function () {
      root = await mkdtemp(path.join(tmpdir(), "zettlr-reference-journal-"));
      const interrupted = path.join(root, "Interrupted.md");
      const untouched = path.join(root, "Untouched.md");
      writeFileSync(interrupted, "installed target\n", "utf-8");
      writeFileSync(untouched, "original\n", "utf-8");

      // The journal a crash between installations leaves behind.
      writeFileSync(
        path.join(userData, "workspace-edit-journal.json"),
        JSON.stringify({
          transactionId: "crashed-transaction",
          phase: "installing",
          closedFiles: [
            { documentPath: interrupted, original: "original\n", target: "installed target\n" },
            { documentPath: untouched, original: "original\n", target: "never installed\n" },
          ],
          openBuffers: [],
        }),
        "utf-8",
      );

      provider = new ReferenceProvider(
        new LogProvider(),
        new EventEmitter(),
        {
          readMarkdownBufferContent: () => undefined,
          applyWorkspaceTextEdits: async () => [],
        },
        500,
        userData,
        {
          schedule: (callback: () => void) => {
            callback();
            return { cancel: () => {} };
          },
        },
      );
      await provider.boot();

      assert.equal(
        readFileSync(interrupted, "utf-8"),
        "original\n",
        "the installed file must be rolled back",
      );
      assert.equal(
        readFileSync(untouched, "utf-8"),
        "original\n",
        "the file that was never installed stays as it is",
      );
      assert.equal(
        existsSync(path.join(userData, "workspace-edit-journal.json")),
        false,
        "finished recovery deletes the journal",
      );
    });
  });
});
