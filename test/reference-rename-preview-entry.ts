/**
 * Mounts the production rename-preview dialog for the Chromium input probe
 * (reference-rename-preview-probe.cjs). Issue #1, review A4 red.
 *
 * The probe delivers the raw fixture documents; this entry runs the REAL
 * extractor over them, previews the rename with the REAL
 * previewReferenceRename(), and builds the per-file summary with the REAL
 * buildRenamePreviewSummary() — the same pipeline MainEditor.vue feeds the
 * dialog from. The dialog is resolved through a webpack context so its
 * ABSENCE is a structured, reportable state instead of a bundler crash.
 *
 * Dialog contract exercised here (locked by
 * test/reference-rename-preview.spec.ts):
 *
 * - default export of source/win-main/RenameReferencePreviewDialog.vue
 * - props: {
 *     oldKey: string,
 *     newKey: string,
 *     files: RenamePreviewFileSummary[]   — the previewed per-file summary
 *   }
 * - root element carries class 'rename-preview-dialog'
 * - '[data-rename-old-key]' and '[data-rename-new-key]' show the two keys
 * - every affected document renders a row carrying data-preview-path (the
 *   documentPath) and data-preview-count (the edit count), listing one
 *   '.snippet' element per affected range with the authored context
 * - '[data-apply]' emits exactly one 'apply'; '[data-cancel]' emits
 *   'close' and never 'apply' — Cancel commits nothing, the host commits
 *   only on 'apply'
 */

import {
  buildRenamePreviewSummary,
  previewReferenceRename,
  type RenamePreviewFileSummary,
} from "source/common/pandoc-util/compute-reference-edits";
import { extractReferences } from "source/common/pandoc-util/extract-references";
import { createApp, nextTick } from "vue";

interface ProbeDocument {
  path: string;
  content: string;
}

interface MountReport {
  componentAvailable: boolean;
  componentFailure: string | null;
  /** The summary computed with the real preview pipeline (the oracle input) */
  expectedFiles: RenamePreviewFileSummary[];
}

interface DialogState {
  oldKey: string | null;
  newKey: string | null;
  rows: Array<{ documentPath: string | null; editCount: number | null; snippets: string[] }>;
  applyPresent: boolean;
  cancelPresent: boolean;
}

declare global {
  interface Window {
    renamePreviewProbeMount: (
      documents: ProbeDocument[],
      oldKey: string,
      newKey: string,
    ) => Promise<MountReport>;
    renamePreviewProbeState: () => DialogState;
    renamePreviewProbeEvents: () => { applyCount: number; closeCount: number };
    renamePreviewProbeClick: (selector: string) => boolean;
  }
}

// Resolved through a context (not a static import) so the bundle builds and
// reports structured absence while the dialog does not exist yet.
const dialogContext = require.context(
  "../source/win-main/",
  false,
  /RenameReferencePreviewDialog\.vue$/,
);

let applyCount = 0;
let closeCount = 0;

window.renamePreviewProbeMount = async (
  documents: ProbeDocument[],
  oldKey: string,
  newKey: string,
): Promise<MountReport> => {
  const snapshots = documents.map((document) => extractReferences(document.path, document.content));
  const preview = previewReferenceRename(snapshots, oldKey, newKey);
  if (preview.status !== "ok") {
    return {
      componentAvailable: false,
      componentFailure: `the fixture rename must preview cleanly, got rejection ${JSON.stringify(preview.reason)}`,
      expectedFiles: [],
    };
  }

  const expectedFiles = buildRenamePreviewSummary(preview.edit, snapshots, oldKey);

  const dialogKey = dialogContext
    .keys()
    .find((key) => key.includes("RenameReferencePreviewDialog"));
  if (dialogKey === undefined) {
    return {
      componentAvailable: false,
      componentFailure:
        "source/win-main/RenameReferencePreviewDialog.vue does not exist yet (review A4 red)",
      expectedFiles,
    };
  }

  const dialogModule = dialogContext(dialogKey) as { default?: unknown };
  if (dialogModule.default === undefined) {
    return {
      componentAvailable: false,
      componentFailure:
        "RenameReferencePreviewDialog.vue exists but has no default component export",
      expectedFiles,
    };
  }

  // The host contract: either intent closes the preview surface (the
  // production host clears its prompt state) — the probe mirrors that by
  // unmounting, so the after-cancel/after-apply captures show the REAL
  // closed state instead of a frozen receipt frame.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = createApp(dialogModule.default as any, {
    oldKey,
    newKey,
    files: expectedFiles,
    onApply: () => {
      applyCount++;
      app.unmount();
    },
    onClose: () => {
      closeCount++;
      app.unmount();
    },
  });
  app.mount("#app");

  await nextTick();
  await document.fonts.ready;
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

  return { componentAvailable: true, componentFailure: null, expectedFiles };
};

window.renamePreviewProbeState = (): DialogState => {
  const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-preview-path]"));
  return {
    oldKey: document.querySelector("[data-rename-old-key]")?.textContent?.trim() ?? null,
    newKey: document.querySelector("[data-rename-new-key]")?.textContent?.trim() ?? null,
    rows: rows.map((row) => {
      const count = row.getAttribute("data-preview-count");
      return {
        documentPath: row.getAttribute("data-preview-path"),
        editCount: count === null ? null : Number(count),
        snippets: Array.from(row.querySelectorAll(".snippet")).map(
          (snippet) => snippet.textContent ?? "",
        ),
      };
    }),
    applyPresent: document.querySelector(".rename-preview-dialog [data-apply]") !== null,
    cancelPresent: document.querySelector(".rename-preview-dialog [data-cancel]") !== null,
  };
};

window.renamePreviewProbeEvents = () => ({ applyCount, closeCount });

window.renamePreviewProbeClick = (selector: string): boolean => {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) {
    return false;
  }
  element.click();
  return true;
};
