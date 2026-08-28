/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Reference key-edit prompt extension
 * CVM-Role:        CodeMirror Extension
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Detects direct edits of authored definition-id tokens
 *                  (issue #1 Phase 6; contract locked by
 *                  test/reference-create-label.spec.ts): when the primary
 *                  selection LEAVES an edited definition-id range whose key
 *                  now differs from the last-known snapshot's key, the
 *                  extension emits EXACTLY ONE prompt intent
 *                  { documentPath, oldKey, newKey, range } where range spans
 *                  the post-edit authored id token including its '#' sigil.
 *
 *                  The intent is a SIGNAL only: acting on it (confirming and
 *                  running the workspace rename over the
 *                  preview-/commit-reference-rename ipc protocol) is host
 *                  wiring, and declining is host behavior — the authored
 *                  edit stays and the Phase 4 diagnostics flag the stale
 *                  uses. After one prompt the tracker rebaselines on the new
 *                  key, so only a NEW edit followed by a new departure can
 *                  prompt again.
 *
 *                  The definition baseline prefers the resolved workspace
 *                  reference view (workspaceReferencesField) when the host
 *                  has fed it; otherwise (and in the probe harness) it is
 *                  extracted from the initial document with the real
 *                  extractor — both carry the same typed snapshot.
 *
 * END HEADER
 */

import { type Extension } from "@codemirror/state";
import { ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { extractReferences } from "@common/pandoc-util/extract-references";
import type { SourceRange } from "@dts/common/references";
import { workspaceReferencesField } from "./workspace-references-field";

/**
 * The prompt intent emitted when the selection leaves an edited
 * definition-id range whose key changed.
 */
export interface ReferenceKeyEditPromptIntent {
  documentPath: string;
  /** The key of the definition per the last-known snapshot */
  oldKey: string;
  /** The authored replacement key currently in the buffer */
  newKey: string;
  /** The exact post-edit range of the authored id token (with '#' sigil) */
  range: SourceRange;
}

export interface ReferenceKeyEditPromptConfig {
  /** The edited document's path (snapshot identity of the intents) */
  documentPath: string;
  /** Called exactly once per departure from an edited, key-changed id */
  onPrompt: (intent: ReferenceKeyEditPromptIntent) => void;
}

/**
 * One tracked definition id: the baseline key, the live-mapped token range,
 * whether an edit has touched the range since the last baseline, and whether
 * the primary selection was inside the range after the previous update.
 */
interface DefinitionTracker {
  oldKey: string;
  from: number;
  to: number;
  edited: boolean;
  headInside: boolean;
}

/**
 * Creates the reference key-edit prompt extension for one document.
 *
 * @param   {ReferenceKeyEditPromptConfig}  config  The document and callback
 *
 * @return  {Extension}                             The editor extension
 */
export default function referenceKeyEditPrompt(config: ReferenceKeyEditPromptConfig): Extension {
  return ViewPlugin.define((view) => {
    const initialHead = view.state.selection.main.head;

    // Baseline: the definitions of the last-known snapshot. Prefer the
    // host-fed resolved workspace view; fall back to extracting the initial
    // document with the real extractor.
    const fieldState = view.state.field(workspaceReferencesField, false);
    const definitions =
      fieldState?.snapshot.documentPath === config.documentPath
        ? fieldState.snapshot.definitions
        : extractReferences(config.documentPath, view.state.doc.toString()).definitions;

    const trackers: DefinitionTracker[] = definitions.map((definition) => ({
      oldKey: definition.key,
      from: definition.range.from,
      to: definition.range.to,
      edited: false,
      headInside: initialHead >= definition.range.from && initialHead <= definition.range.to,
    }));

    return {
      update(update: ViewUpdate) {
        if (update.docChanged) {
          // Mark trackers whose (pre-change) range an edit touched, then map
          // the ranges into the new document. Both boundaries map with
          // positive association so an insertion at the token end extends
          // the tracked range over the appended characters.
          update.changes.iterChangedRanges((fromA, toA) => {
            for (const tracker of trackers) {
              if (fromA <= tracker.to && toA >= tracker.from) {
                tracker.edited = true;
              }
            }
          });
          for (const tracker of trackers) {
            tracker.from = update.changes.mapPos(tracker.from, 1);
            tracker.to = update.changes.mapPos(tracker.to, 1);
          }
        }

        const head = update.state.selection.main.head;
        for (const tracker of trackers) {
          const inside = head >= tracker.from && head <= tracker.to;

          if (tracker.edited && tracker.headInside && !inside) {
            // The selection just LEFT an edited id range: compare the
            // authored key against the baseline, prompting on a change.
            const snapshot = extractReferences(config.documentPath, update.state.doc.toString());
            const definition = snapshot.definitions.find(
              (d) => d.range.from <= tracker.to && d.range.to >= tracker.from,
            );

            if (definition !== undefined && definition.key !== tracker.oldKey) {
              const intent: ReferenceKeyEditPromptIntent = {
                documentPath: config.documentPath,
                oldKey: tracker.oldKey,
                newKey: definition.key,
                range: { from: definition.range.from, to: definition.range.to },
              };
              // Decouple the host callback from the view update cycle: the
              // host may dispatch transactions or invoke ipc.
              queueMicrotask(() => {
                config.onPrompt(intent);
              });

              // Rebaseline: one prompt per departure. Only a NEW edit of
              // the (new) key followed by a new departure prompts again.
              tracker.oldKey = definition.key;
              tracker.from = definition.range.from;
              tracker.to = definition.range.to;
            }

            // Whether the key changed or the edit was reverted in place,
            // the edit episode is over once the selection departs.
            tracker.edited = false;
          }

          tracker.headInside = inside;
        }
      },
    };
  });
}
