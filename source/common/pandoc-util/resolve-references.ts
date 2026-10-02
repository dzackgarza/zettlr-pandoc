/**
 * Resolves every reference key across a set of document snapshots into a
 * workspace-wide resolution map (issue #1).
 *
 * Renderer-safe: no Node built-ins and no CodeMirror imports.
 */

import type {
  DocumentReferenceSnapshot,
  ReferenceDefinition,
  Resolution,
} from "../../types/common/references";

/**
 * Resolves the workspace: every key that is defined or referenced in any
 * snapshot maps to exactly one Resolution. Unique definitions resolve,
 * undefined keys are missing, and duplicated keys retain every definition.
 *
 * @param   {DocumentReferenceSnapshot[]}  snapshots  All workspace snapshots
 *
 * @return  {Map<string, Resolution>}  Resolution per reference key
 */
export function resolveWorkspace(snapshots: DocumentReferenceSnapshot[]): Map<string, Resolution> {
  const definitionsByKey = new Map<string, ReferenceDefinition[]>();
  const referencedKeys = new Set<string>();

  for (const snapshot of snapshots) {
    for (const definition of snapshot.definitions) {
      const existing = definitionsByKey.get(definition.key);
      if (existing === undefined) {
        definitionsByKey.set(definition.key, [definition]);
      } else {
        existing.push(definition);
      }
    }

    for (const occurrence of snapshot.occurrences) {
      referencedKeys.add(occurrence.key);
    }
  }

  const resolutions = new Map<string, Resolution>();

  for (const [key, definitions] of definitionsByKey) {
    resolutions.set(
      key,
      definitions.length === 1
        ? { status: "resolved", definition: definitions[0] }
        : { status: "duplicate", definitions },
    );
  }

  for (const key of referencedKeys) {
    if (!resolutions.has(key)) {
      resolutions.set(key, { status: "missing" });
    }
  }

  return resolutions;
}
