/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TabManager per-pane navigation history specs (issue #1 Phase 5 red)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the REAL TabManager class headlessly. The class has
 *                  no constructor dependencies and only a type-only import,
 *                  so it is directly importable under the Mocha/tsx harness
 *                  (test/document-tree.spec.ts already imports the same
 *                  document-tree modules).
 *
 *                  Phase 5 contract locked red here (workstream 4): history
 *                  entries widen from bare path strings to
 *                  { path, location?: DocumentLocation } so Back/Forward can
 *                  restore the exact source selection, viewport scroll, and
 *                  folds captured at jump time. The widened surface:
 *
 *                  - `history`: readonly widened entry list (observability
 *                    surface for the provider and for these specs),
 *                  - `updateCurrentHistoryLocation(location)`: stamps the
 *                    CURRENT entry with the location captured when the pane
 *                    is about to jump away from it,
 *                  - `back()` / `forward()`: return the widened entry that
 *                    was navigated to (or null at a history boundary) so the
 *                    documents provider can broadcast the location for the
 *                    renderer to restore.
 *
 *                  PERSISTENCE FINDING (checked before writing this spec):
 *                  TabManagerJSON serializes only { openFiles, activeFile }
 *                  (tab-manager.ts toJSON) and DocumentTree.fromJSON restores
 *                  panes without any history — session history is in-memory
 *                  only and there is NO serialized legacy history format to
 *                  feed. Legacy tolerance therefore means: entries created by
 *                  today's path-only openFile() flow (never stamped with a
 *                  location) must keep restoring exactly as today. The parity
 *                  block below locks that current behavior green; the widened
 *                  block fails on assertions against the real current class,
 *                  whose entries lack locations.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { TabManager } from "../source/app/service-providers/documents/document-tree/tab-manager";
import type { DocumentLocation } from "../source/types/common/references";
import "mocha";

const FILE_A = "/workspace/ProjectA/Halphen_Surfaces.md";
const FILE_B = "/workspace/ProjectA/Theorems.md";
const FILE_C = "/workspace/ProjectA/Coble_Lattice_Table.md";

/**
 * A widened history entry: today's entries are bare path strings; Phase 5
 * widens them to carry the optional DocumentLocation captured at jump time.
 */
interface HistoryEntry {
  path: string;
  location?: DocumentLocation;
}

/**
 * The Phase 5 widened TabManager surface these specs assert against. The
 * cast below is intentional: the widened members do not exist on the real
 * class yet, so reading them yields undefined and the specs fail on
 * assertions (never on compile errors or crashes).
 */
interface Phase5TabManager {
  history: readonly HistoryEntry[];
  updateCurrentHistoryLocation: (location: DocumentLocation) => void;
  back: () => HistoryEntry | null;
  forward: () => HistoryEntry | null;
}

function widen(tabMan: TabManager): Phase5TabManager {
  return tabMan as unknown as Phase5TabManager;
}

/**
 * A realistic captured location: a nontrivial selection inside the document,
 * a scrolled viewport, and one collapsed fold.
 */
function makeLocation(documentPath: string, generation: number): DocumentLocation {
  return {
    documentPath,
    selection: { anchor: 482, head: 505 },
    scrollTop: 1240,
    folds: [{ from: 133, to: 407 }],
    sourceGeneration: generation,
  };
}

describe("TabManager per-pane navigation history (issue #1 Phase 5)", function () {
  describe("path-only parity (current behavior, must stay green)", function () {
    it("walks back and forward through a three-file session by path", function () {
      const tabMan = new TabManager();
      tabMan.openFile(FILE_A);
      tabMan.openFile(FILE_B);
      tabMan.openFile(FILE_C);
      assert.equal(tabMan.activeFile?.path, FILE_C);

      tabMan.back();
      assert.equal(tabMan.activeFile?.path, FILE_B);
      tabMan.back();
      assert.equal(tabMan.activeFile?.path, FILE_A);
      tabMan.forward();
      assert.equal(tabMan.activeFile?.path, FILE_B);
      tabMan.forward();
      assert.equal(tabMan.activeFile?.path, FILE_C);
    });

    it("keeps out-of-bounds moves at both history ends as no-ops", function () {
      const tabMan = new TabManager();
      tabMan.openFile(FILE_A);
      tabMan.openFile(FILE_B);

      tabMan.back();
      assert.equal(tabMan.activeFile?.path, FILE_A);
      tabMan.back(); // Already at the oldest entry
      assert.equal(tabMan.activeFile?.path, FILE_A);

      tabMan.forward();
      assert.equal(tabMan.activeFile?.path, FILE_B);
      tabMan.forward(); // Already at the newest entry
      assert.equal(tabMan.activeFile?.path, FILE_B);
    });

    it("deduplicates a reopened path by moving it to the newest position", function () {
      const tabMan = new TabManager();
      tabMan.openFile(FILE_A);
      tabMan.openFile(FILE_B);
      tabMan.openFile(FILE_A);
      assert.equal(tabMan.activeFile?.path, FILE_A);

      // History is now [B, A]: back lands on B, not on the stale first A.
      tabMan.back();
      assert.equal(tabMan.activeFile?.path, FILE_B);
    });

    it("keeps jump-opened tabs open when walking back", function () {
      const tabMan = new TabManager();
      tabMan.openFile(FILE_A);
      tabMan.openFile(FILE_B);

      tabMan.back();
      assert.equal(tabMan.activeFile?.path, FILE_A);
      assert.deepEqual(
        tabMan.openFiles.map((doc) => doc.path).sort(),
        [FILE_A, FILE_B].sort(),
        "walking back must re-activate the source tab without closing the jump-opened tab",
      );
    });

    it("keeps the persisted JSON surface at { openFiles, activeFile }", function () {
      // History is session-only today: toJSON carries no history and
      // DocumentTree.fromJSON restores none. This locks the two fields the
      // widening must not corrupt; it deliberately does not forbid Phase 5
      // from making its own (explicit) persistence decision.
      const tabMan = new TabManager();
      tabMan.openFile(FILE_A);
      tabMan.openFile(FILE_B);

      const json = tabMan.toJSON();
      assert.deepEqual(
        json.openFiles.map((doc) => doc.path),
        [FILE_A, FILE_B],
      );
      assert.equal(json.activeFile?.path, FILE_B);
    });
  });

  describe("widened { path, location? } entries (Phase 5 red)", function () {
    it("exposes the session history as widened { path, location? } entries", function () {
      const tabMan = new TabManager();
      tabMan.openFile(FILE_A);
      tabMan.openFile(FILE_B);

      const history = widen(tabMan).history;
      assert.ok(
        Array.isArray(history),
        "Phase 5 widening: TabManager must expose a readonly `history` of { path, location? } entries (currently absent)",
      );
      assert.deepEqual(
        history.map((entry) => entry.path),
        [FILE_A, FILE_B],
        "the widened history must contain one entry per session step, in order",
      );
      assert.ok(
        history.every((entry) => entry.location === undefined),
        "entries created without a captured location must carry location: undefined",
      );
    });

    it("stamps the current entry with the location captured before a jump", function () {
      const tabMan = new TabManager();
      const widened = widen(tabMan);
      tabMan.openFile(FILE_A);

      assert.equal(
        typeof widened.updateCurrentHistoryLocation,
        "function",
        "Phase 5 widening: TabManager must expose updateCurrentHistoryLocation(location) (currently absent)",
      );

      const locationA = makeLocation(FILE_A, 17);
      widened.updateCurrentHistoryLocation(locationA);
      tabMan.openFile(FILE_B);

      const entryA = widened.history.find((entry) => entry.path === FILE_A);
      assert.ok(entryA !== undefined, "the origin entry must remain in history after the jump");
      assert.deepEqual(
        entryA.location,
        locationA,
        "the origin entry must carry the exact DocumentLocation captured at jump time",
      );
    });

    it("back() returns the widened entry it restored, including the stamped location", function () {
      const tabMan = new TabManager();
      const widened = widen(tabMan);
      const locationA = makeLocation(FILE_A, 3);

      tabMan.openFile(FILE_A);
      widened.updateCurrentHistoryLocation?.(locationA);
      tabMan.openFile(FILE_B);

      const restored = widened.back();
      assert.equal(
        tabMan.activeFile?.path,
        FILE_A,
        "back() must re-activate the source tab (parity)",
      );
      assert.deepEqual(
        restored,
        { path: FILE_A, location: locationA },
        "Phase 5 widening: back() must return the restored { path, location } entry so the provider can broadcast the exact location (currently returns undefined)",
      );
    });

    it("restores legacy path-only entries exactly as today, with location undefined", function () {
      const tabMan = new TabManager();
      const widened = widen(tabMan);

      // The legacy flow: today's openFile() path-only pushes, never stamped.
      tabMan.openFile(FILE_A);
      tabMan.openFile(FILE_B);

      const restored = widened.back();
      assert.equal(
        tabMan.activeFile?.path,
        FILE_A,
        "path-only entries must keep restoring by path exactly as today",
      );
      assert.deepEqual(
        restored,
        { path: FILE_A, location: undefined },
        "a legacy path-only entry must surface as { path, location: undefined }, never a fabricated location",
      );
    });

    it("spans tabs within one pane, restoring each stamped location in turn", function () {
      const tabMan = new TabManager();
      const widened = widen(tabMan);
      const locationA = makeLocation(FILE_A, 5);
      const locationB = makeLocation(FILE_B, 9);

      tabMan.openFile(FILE_A);
      widened.updateCurrentHistoryLocation?.(locationA);
      tabMan.openFile(FILE_B);
      widened.updateCurrentHistoryLocation?.(locationB);
      tabMan.openFile(FILE_C);

      assert.equal(
        tabMan.openFiles.length,
        3,
        "the pane must keep all three jump-opened tabs open",
      );

      const firstBack = widened.back();
      assert.equal(tabMan.activeFile?.path, FILE_B);
      assert.deepEqual(firstBack, { path: FILE_B, location: locationB });

      const secondBack = widened.back();
      assert.equal(tabMan.activeFile?.path, FILE_A);
      assert.deepEqual(secondBack, { path: FILE_A, location: locationA });

      assert.equal(
        tabMan.openFiles.length,
        3,
        "walking the whole span back must not close any tab",
      );
    });

    it("returns null (and moves nothing) at both history boundaries", function () {
      const tabMan = new TabManager();
      const widened = widen(tabMan);

      assert.equal(
        widened.back(),
        null,
        "Phase 5 widening: back() on an empty history must return null (currently returns undefined)",
      );

      tabMan.openFile(FILE_A);
      tabMan.openFile(FILE_B);
      widened.back();

      assert.equal(
        widened.back(),
        null,
        "back() at the oldest entry must return null and keep the pane unchanged",
      );
      assert.equal(tabMan.activeFile?.path, FILE_A);

      widened.forward();
      assert.equal(
        widened.forward(),
        null,
        "forward() at the newest entry must return null and keep the pane unchanged",
      );
      assert.equal(tabMan.activeFile?.path, FILE_B);
    });
  });
});
