/**
 * Mounts the production Create-reference-label dialog and the definition
 * key-edit prompt editor scene for the Chromium input probe
 * (reference-create-label-probe.cjs). Issue #1, Phase 6 red.
 *
 * The probe delivers the raw fixture documents; this entry runs the REAL
 * extractor over them for the workspace key set. Both production surfaces
 * are resolved through webpack contexts so their ABSENCE is a structured,
 * reportable state (the Phase 6 red) instead of a bundler crash.
 *
 * Dialog contract exercised here (locked red by
 * test/reference-create-label.spec.ts):
 *
 * - default export of source/win-main/CreateReferenceLabelDialog.vue
 * - props: {
 *     family: ReferenceFamily        — FIXED by the invoking context (the
 *                                      editor context menu names the family;
 *                                      the dialog never lets it change),
 *     proposedSlug: string           — the editable initial slug proposal,
 *     existingKeys: string[]         — every workspace definition key (the
 *                                      production host fetches these over
 *                                      the reference-provider 'get-snapshot'
 *                                      ipc command; the probe supplies the
 *                                      same data extracted with the real
 *                                      extractor at the same seam)
 *   }
 * - root element carries class 'create-reference-label-dialog'
 * - the fixed prefix renders in '[data-family-prefix]' as 'thm:' (never an
 *   input)
 * - the slug <input> autofocuses on mount holding proposedSlug, so real
 *   keyboard input appends without programmatic focus
 * - '[data-uniqueness]' reports the live workspace-uniqueness verdict of
 *   family + ':' + slug as attribute value 'taken' | 'available'
 * - the confirm button '[data-confirm]' is disabled while the verdict is
 *   'taken' (or the slug is empty); Enter in the slug input confirms when
 *   available
 * - confirming emits one 'create' event whose payload is the SEAM this
 *   probe records: { key, insertText, clipboardText } with
 *   insertText === '#' + key (the explicit label token the host inserts at
 *   the target) and clipboardText === '@' + key (what the host copies and
 *   confirms with a toast). Insertion position, clipboard write, and toast
 *   are host-owned and out of the dialog's contract.
 *
 * Key-edit prompt contract exercised here:
 *
 * - default export of source/common/modules/markdown-editor/plugins/
 *   reference-key-edit-prompt.ts:
 *   referenceKeyEditPrompt({ documentPath, onPrompt }): Extension
 * - after the primary selection LEAVES an edited definition-id range whose
 *   key differs from the last snapshot's key, the extension calls onPrompt
 *   ONCE with { documentPath, oldKey, newKey, range } where range spans the
 *   post-edit authored id token including its '#' sigil. Declining the
 *   prompt is host behavior (the edit stays; Phase 4 diagnostics already
 *   flag the stale uses) and is not part of this extension's contract.
 */

import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { SourceRange } from "@dts/common/references";
import { extractReferences } from "source/common/pandoc-util/extract-references";
import { createApp, nextTick } from "vue";

interface ProbeDocument {
  path: string;
  content: string;
}

interface CreateIntent {
  key: string;
  insertText: string;
  clipboardText: string;
}

interface KeyEditPromptIntent {
  documentPath: string;
  oldKey: string;
  newKey: string;
  range: SourceRange;
}

interface DialogMountReport {
  componentAvailable: boolean;
  componentFailure: string | null;
}

interface DialogState {
  prefix: string | null;
  slug: string | null;
  uniqueness: string | null;
  confirmDisabled: boolean | null;
}

interface KeyEditPromptReport {
  extensionAvailable: boolean;
  extensionFailure: string | null;
  promptIntents: KeyEditPromptIntent[];
}

declare global {
  interface Window {
    createLabelProbeMount: (documents: ProbeDocument[]) => Promise<DialogMountReport>;
    createLabelProbeState: () => DialogState;
    createLabelProbeCreateIntents: () => CreateIntent[];
    keyEditPromptProbeRun: (document: ProbeDocument) => Promise<KeyEditPromptReport>;
  }
}

// Resolved through contexts (not static imports) so the bundle builds and
// reports structured absence while the surfaces do not exist yet.
const dialogContext = require.context(
  "../source/win-main/",
  false,
  /CreateReferenceLabelDialog\.vue$/,
);
const promptContext = require.context(
  "../source/common/modules/markdown-editor/plugins/",
  false,
  /reference-key-edit-prompt\.ts$/,
);

const recordedCreateIntents: CreateIntent[] = [];

window.createLabelProbeMount = async (documents: ProbeDocument[]): Promise<DialogMountReport> => {
  const existingKeys = documents
    .flatMap((document) => extractReferences(document.path, document.content).definitions)
    .map((definition) => definition.key);

  const dialogKey = dialogContext.keys().find((key) => key.includes("CreateReferenceLabelDialog"));
  if (dialogKey === undefined) {
    return {
      componentAvailable: false,
      componentFailure:
        "source/win-main/CreateReferenceLabelDialog.vue does not exist yet (issue #1 Phase 6 red)",
    };
  }

  const dialogModule = dialogContext(dialogKey) as { default?: unknown };
  if (dialogModule.default === undefined) {
    return {
      componentAvailable: false,
      componentFailure: "CreateReferenceLabelDialog.vue exists but has no default component export",
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createApp(dialogModule.default as any, {
    family: "thm",
    proposedSlug: "torelli",
    existingKeys,
    onCreate: (intent: CreateIntent) => {
      recordedCreateIntents.push(intent);
    },
  }).mount("#app");

  await nextTick();
  await document.fonts.ready;
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

  return { componentAvailable: true, componentFailure: null };
};

window.createLabelProbeState = (): DialogState => {
  const input = document.querySelector<HTMLInputElement>(".create-reference-label-dialog input");
  const prefix = document.querySelector<HTMLElement>("[data-family-prefix]");
  const uniqueness = document.querySelector<HTMLElement>("[data-uniqueness]");
  const confirm = document.querySelector<HTMLButtonElement>("[data-confirm]");
  return {
    prefix: prefix?.textContent?.trim() ?? null,
    slug: input?.value ?? null,
    uniqueness: uniqueness?.getAttribute("data-uniqueness") ?? null,
    confirmDisabled: confirm === null ? null : confirm.disabled,
  };
};

window.createLabelProbeCreateIntents = () => recordedCreateIntents;

window.keyEditPromptProbeRun = async (
  probeDocument: ProbeDocument,
): Promise<KeyEditPromptReport> => {
  const promptIntents: KeyEditPromptIntent[] = [];

  const promptKey = promptContext.keys().find((key) => key.includes("reference-key-edit-prompt"));
  const extensions: Extension[] = [];
  let extensionFailure: string | null = null;
  if (promptKey === undefined) {
    extensionFailure =
      "source/common/modules/markdown-editor/plugins/reference-key-edit-prompt.ts does not exist yet (issue #1 Phase 6 red)";
  } else {
    const promptModule = promptContext(promptKey) as {
      default?: (config: {
        documentPath: string;
        onPrompt: (intent: KeyEditPromptIntent) => void;
      }) => Extension;
    };
    if (promptModule.default === undefined) {
      extensionFailure =
        "reference-key-edit-prompt.ts exists but has no default extension factory export";
    } else {
      extensions.push(
        promptModule.default({
          documentPath: probeDocument.path,
          onPrompt: (intent) => {
            promptIntents.push(intent);
          },
        }),
      );
    }
  }

  const host = document.createElement("div");
  host.id = "key-edit-prompt-scene";
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({ doc: probeDocument.content, extensions }),
    parent: host,
  });

  // Edit the authored definition id: '#thm:torelli' -> '#thm:torelli-v2',
  // leaving the selection at the end of the edited token …
  const token = "#thm:torelli";
  const tokenStart = probeDocument.content.indexOf(token);
  const editAt = tokenStart + token.length;
  view.dispatch({
    changes: { from: editAt, to: editAt, insert: "-v2" },
    selection: { anchor: editAt + "-v2".length },
  });
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  // … then move the selection OUT of the edited id range: this is the
  // moment the prompt intent must fire (exactly once).
  view.dispatch({ selection: { anchor: 0 } });
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  return {
    extensionAvailable: promptKey !== undefined && extensionFailure === null,
    extensionFailure,
    promptIntents,
  };
};
