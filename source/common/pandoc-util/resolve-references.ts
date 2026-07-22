/**
 * Resolves every reference key across a set of document snapshots into a
 * workspace-wide resolution map (issue #1).
 *
 * Renderer-safe: no Node built-ins and no CodeMirror imports.
 */

import type { DocumentReferenceSnapshot, Resolution } from '../../types/common/references'

/**
 * Resolves the workspace: every key that is defined or referenced in any
 * snapshot maps to exactly one Resolution. Unique definitions resolve,
 * undefined keys are missing, and duplicated keys retain every definition.
 *
 * @param   {DocumentReferenceSnapshot[]}  _snapshots  All workspace snapshots
 *
 * @return  {Map<string, Resolution>}  Resolution per reference key
 */
export function resolveWorkspace (_snapshots: DocumentReferenceSnapshot[]): Map<string, Resolution> {
  // Workspace resolution lands with the green commit for issue #1.
  return new Map()
}
