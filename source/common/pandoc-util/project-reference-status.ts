/**
 * Project-membership status computation for workspace references
 * (issue #1 Phase 7).
 *
 * This module is the PURE half of the Project-status feature. It runs in the
 * main process (the reference provider annotates the completion database) and
 * in the renderer (hover tooltips derive the displayed status), so it must
 * stay renderer-safe: no Node built-ins, no Electron, no CodeMirror imports,
 * and no filesystem access. Project roots arrive as explicit ProjectRootSpec
 * values (the pure projection of DirDescriptor.settings.project) — the
 * functions never read .ztr-directory files themselves.
 *
 * CONTRACT (locked red by test/project-reference-status.spec.ts):
 *
 * computeProjectReferenceStatus(definitionPath, activeDocumentPath, roots):
 *
 * - 'same-file' when definitionPath === activeDocumentPath; this always wins,
 *   regardless of Project membership.
 * - The ACTIVE Project is the root whose rootPath contains
 *   activeDocumentPath. Containment is path-segment-safe: /w/ProjectA never
 *   contains /w/ProjectAB/x.md. An active document inside a root activates
 *   that root even when the document itself is omitted from the root's
 *   `files` list.
 * - With an active Project:
 *     - definition in the same root and listed in `files`
 *       -> 'in-active-project'
 *     - definition in the same root but NOT listed -> 'omitted-from-active-project'
 *     - definition under a different root -> 'another-project'
 *     - definition under no root -> 'standalone'
 * - Without an active Project (standalone active document):
 *     - definition under any root -> 'another-project'
 *     - definition under no root -> 'standalone'
 *
 * computeAppendAndContinuePlan(targetDocumentPath, activeDocumentPath, roots):
 *
 * - Returns a plan only when the active document lives in a Project root AND
 *   the target lives in that SAME root AND the target is omitted from its
 *   `files` list; every other configuration returns null (included targets,
 *   other-Project targets, standalone targets, standalone active documents).
 * - `appendFiles` holds ordered project-relative Unix-separator paths: when
 *   the active (source) document is itself omitted it comes FIRST, then the
 *   target. Both are appended in one operation and both are named in one
 *   toast (appendToastMessage).
 *
 * applyAppendPlan(settings, plan):
 *
 * - Returns a NEW ProjectSettings whose `files` is the existing ordered list
 *   with plan.appendFiles appended at the end (existing order and every other
 *   property preserved; the input object is never mutated). The returned
 *   value is exactly the `properties` payload of the existing dir-settings
 *   surface — the 'update-project-properties' command, which calls
 *   FSAL.updateProject(dir, properties) — so appending never needs a new ipc
 *   channel or a dialog.
 *
 * annotateCompletionEntries(entries, activeDocumentPath, roots):
 *
 * - Returns new entries with `projectStatus` computed for every entry and
 *   `appendPlan` attached exactly on 'omitted-from-active-project' entries.
 *   The input entries are not mutated.
 *
 * completionAffordanceFor(status, appendPlan):
 *
 * - The fixed decision table feeding the completion surface:
 *     undefined            -> { kind: 'insert' }   (Phase-3 compatibility)
 *     'same-file'          -> { kind: 'insert' }
 *     'in-active-project'  -> { kind: 'insert' }
 *     'another-project'    -> { kind: 'disabled-another-project' }
 *     'omitted-from-active-project' with a plan
 *                          -> { kind: 'insert-with-append', plan }
 *     'omitted-from-active-project' without a plan
 *                          -> { kind: 'insert' }  (no mechanical append
 *                             available; plain insertion remains)
 *     'standalone'         -> { kind: 'insert-with-export-warning' }
 *
 * projectStatusDisplayName(status): the exact user-facing status wording
 * shown in hovers ('In active Project', 'Omitted from active Project',
 * 'Another Project', 'Standalone document', 'This file').
 */

import type { ProjectSettings } from '../../types/common/fsal'
import type {
  AppendAndContinuePlan,
  ProjectReferenceStatus,
  ProjectRootSpec,
  ReferenceCompletionEntry
} from '../../types/common/references'

/**
 * How a status-carrying completion entry may be inserted: plainly, not at
 * all (another Project), with a mechanical append-and-continue action, or
 * with an export-unit warning.
 */
export type CompletionInsertionAffordance =
  | { kind: 'insert' }
  | { kind: 'disabled-another-project' }
  | { kind: 'insert-with-append', plan: AppendAndContinuePlan }
  | { kind: 'insert-with-export-warning' }

/**
 * Computes the Project-membership status of one definition relative to the
 * active document and the visible Project roots. See the module contract.
 *
 * @param   {string}                  _definitionPath      The definition's documentPath
 * @param   {string}                  _activeDocumentPath  The active (source) document
 * @param   {ProjectRootSpec[]}       _projectRoots        Every visible Project root
 *
 * @return  {ProjectReferenceStatus}                       The membership status
 */
export function computeProjectReferenceStatus (
  _definitionPath: string,
  _activeDocumentPath: string,
  _projectRoots: ProjectRootSpec[]
): ProjectReferenceStatus {
  // Phase 7 skeleton (issue #1): the real computation is the green step.
  return 'standalone'
}

/**
 * Computes the append-and-continue plan for inserting a reference to
 * `targetDocumentPath` while editing `activeDocumentPath`. See the module
 * contract.
 *
 * @param   {string}             _targetDocumentPath  The omitted target document
 * @param   {string}             _activeDocumentPath  The active (source) document
 * @param   {ProjectRootSpec[]}  _projectRoots        Every visible Project root
 *
 * @return  {AppendAndContinuePlan|null}              The plan, or null
 */
export function computeAppendAndContinuePlan (
  _targetDocumentPath: string,
  _activeDocumentPath: string,
  _projectRoots: ProjectRootSpec[]
): AppendAndContinuePlan|null {
  // Phase 7 skeleton (issue #1): the real computation is the green step.
  return null
}

/**
 * Applies an append-and-continue plan to a ProjectSettings value, returning
 * the new settings object the 'update-project-properties' command consumes.
 * See the module contract.
 *
 * @param   {ProjectSettings}        settings  The current project settings
 * @param   {AppendAndContinuePlan}  _plan     The plan to apply
 *
 * @return  {ProjectSettings}                  The new settings (input unmutated)
 */
export function applyAppendPlan (
  settings: ProjectSettings,
  _plan: AppendAndContinuePlan
): ProjectSettings {
  // Phase 7 skeleton (issue #1): the real application is the green step.
  return settings
}

/**
 * The single confirmation toast for an applied append-and-continue plan; it
 * names EVERY appended file (both source and target when the source was
 * itself omitted).
 *
 * @param   {AppendAndContinuePlan}  _plan  The applied plan
 *
 * @return  {string}                        The toast message
 */
export function appendToastMessage (_plan: AppendAndContinuePlan): string {
  // Phase 7 skeleton (issue #1): the real message is the green step.
  return ''
}

/**
 * Annotates completion entries with their computed projectStatus (and, on
 * omitted entries, the appendPlan). See the module contract.
 *
 * @param   {ReferenceCompletionEntry[]}  entries              The raw entries
 * @param   {string}                      _activeDocumentPath  The active document
 * @param   {ProjectRootSpec[]}           _projectRoots        Every visible root
 *
 * @return  {ReferenceCompletionEntry[]}                       Annotated entries
 */
export function annotateCompletionEntries (
  entries: ReferenceCompletionEntry[],
  _activeDocumentPath: string,
  _projectRoots: ProjectRootSpec[]
): ReferenceCompletionEntry[] {
  // Phase 7 skeleton (issue #1): the real annotation is the green step.
  return entries.map(entry => ({ ...entry, projectStatus: 'standalone' }))
}

/**
 * The fixed status -> insertion affordance decision table of the completion
 * surface. See the module contract.
 *
 * @param   {ProjectReferenceStatus|undefined}  _status      The entry's status
 * @param   {AppendAndContinuePlan}             _appendPlan  The entry's plan, if any
 *
 * @return  {CompletionInsertionAffordance}                  The affordance
 */
export function completionAffordanceFor (
  _status: ProjectReferenceStatus|undefined,
  _appendPlan?: AppendAndContinuePlan
): CompletionInsertionAffordance {
  // Phase 7 skeleton (issue #1): the real decision table is the green step.
  return { kind: 'insert' }
}

/**
 * The exact user-facing wording of a Project status, shown in the hover
 * tooltip's [data-reference-project-status] element.
 *
 * @param   {ProjectReferenceStatus}  _status  The status
 *
 * @return  {string}                           The display wording
 */
export function projectStatusDisplayName (_status: ProjectReferenceStatus): string {
  // Phase 7 skeleton (issue #1): the real wording is the green step.
  return ''
}
