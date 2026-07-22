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
 * True iff `documentPath` lies strictly inside `rootPath`, path-segment-safe:
 * /w/ProjectA never contains /w/ProjectAB/x.md. Renderer-safe (no Node path
 * module): the character following the root prefix must be a separator.
 *
 * @param   {string}   documentPath  The document's absolute path
 * @param   {string}   rootPath      The Project root's absolute path
 *
 * @return  {boolean}                Whether the root contains the document
 */
function isInsideRoot (documentPath: string, rootPath: string): boolean {
  if (!documentPath.startsWith(rootPath)) {
    return false
  }
  const next = documentPath.charAt(rootPath.length)
  return next === '/' || next === '\\'
}

/**
 * The project-relative Unix-separator path of an in-root document.
 *
 * @param   {string}  documentPath  The document's absolute path
 * @param   {string}  rootPath      The containing Project root
 *
 * @return  {string}                The relative path, '/'-separated
 */
function projectRelativePath (documentPath: string, rootPath: string): string {
  return documentPath.slice(rootPath.length + 1).replace(/\\/g, '/')
}

/**
 * The root containing `documentPath`, if any.
 *
 * @param   {string}             documentPath  The document's absolute path
 * @param   {ProjectRootSpec[]}  projectRoots  Every visible Project root
 *
 * @return  {ProjectRootSpec|undefined}        The containing root
 */
function containingRoot (documentPath: string, projectRoots: ProjectRootSpec[]): ProjectRootSpec|undefined {
  return projectRoots.find(root => isInsideRoot(documentPath, root.rootPath))
}

/**
 * Computes the Project-membership status of one definition relative to the
 * active document and the visible Project roots. See the module contract.
 *
 * @param   {string}                  definitionPath      The definition's documentPath
 * @param   {string}                  activeDocumentPath  The active (source) document
 * @param   {ProjectRootSpec[]}       projectRoots        Every visible Project root
 *
 * @return  {ProjectReferenceStatus}                      The membership status
 */
export function computeProjectReferenceStatus (
  definitionPath: string,
  activeDocumentPath: string,
  projectRoots: ProjectRootSpec[]
): ProjectReferenceStatus {
  if (definitionPath === activeDocumentPath) {
    return 'same-file' // Always wins, regardless of Project membership.
  }

  // The ACTIVE Project is the root containing the active document — even
  // when the active document itself is omitted from the root's files list.
  const activeRoot = containingRoot(activeDocumentPath, projectRoots)
  const definitionRoot = containingRoot(definitionPath, projectRoots)

  if (activeRoot === undefined) {
    // Standalone active document: any Project-rooted target is foreign.
    return definitionRoot === undefined ? 'standalone' : 'another-project'
  }

  if (definitionRoot === undefined) {
    return 'standalone'
  }

  if (definitionRoot.rootPath !== activeRoot.rootPath) {
    return 'another-project'
  }

  return activeRoot.files.includes(projectRelativePath(definitionPath, activeRoot.rootPath))
    ? 'in-active-project'
    : 'omitted-from-active-project'
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
  targetDocumentPath: string,
  activeDocumentPath: string,
  projectRoots: ProjectRootSpec[]
): AppendAndContinuePlan|null {
  const status = computeProjectReferenceStatus(targetDocumentPath, activeDocumentPath, projectRoots)
  if (status !== 'omitted-from-active-project') {
    return null // Included, other-Project, standalone, or same-file target.
  }

  // The status above guarantees an active root exists and contains the target.
  const activeRoot = containingRoot(activeDocumentPath, projectRoots)
  if (activeRoot === undefined) {
    throw new Error(`No active Project root contains ${activeDocumentPath} despite an omitted target status`)
  }

  const appendFiles: string[] = []
  const activeRelative = projectRelativePath(activeDocumentPath, activeRoot.rootPath)
  if (!activeRoot.files.includes(activeRelative)) {
    // The omitted SOURCE document comes first, then the target.
    appendFiles.push(activeRelative)
  }
  appendFiles.push(projectRelativePath(targetDocumentPath, activeRoot.rootPath))

  return { rootPath: activeRoot.rootPath, appendFiles }
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
  plan: AppendAndContinuePlan
): ProjectSettings {
  return {
    ...settings,
    files: [ ...settings.files, ...plan.appendFiles ]
  }
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
export function appendToastMessage (plan: AppendAndContinuePlan): string {
  const names = plan.appendFiles.join(' and ')
  return `Added ${names} to the active Project's export file list.`
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
  activeDocumentPath: string,
  projectRoots: ProjectRootSpec[]
): ReferenceCompletionEntry[] {
  return entries.map(entry => {
    const projectStatus = computeProjectReferenceStatus(entry.documentPath, activeDocumentPath, projectRoots)
    let appendPlan
    if (projectStatus === 'omitted-from-active-project') {
      const plan = computeAppendAndContinuePlan(entry.documentPath, activeDocumentPath, projectRoots)
      if (plan === null) {
        // Both functions derive the status from the same pure inputs, so an
        // omitted entry without a plan is a status divergence — a bug, not a
        // presentable state (review B13: fail loud, never silently degrade).
        throw new Error(`No append-and-continue plan for the omitted entry ${entry.key} (${entry.documentPath})`)
      }
      appendPlan = plan
    }
    return { ...entry, projectStatus, appendPlan }
  })
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
  status: ProjectReferenceStatus|undefined,
  appendPlan?: AppendAndContinuePlan
): CompletionInsertionAffordance {
  if (status === 'another-project') {
    return { kind: 'disabled-another-project' }
  }
  if (status === 'omitted-from-active-project' && appendPlan !== undefined) {
    return { kind: 'insert-with-append', plan: appendPlan }
  }
  if (status === 'standalone') {
    return { kind: 'insert-with-export-warning' }
  }
  // undefined (Phase-3 compatibility), 'same-file', 'in-active-project', and
  // omitted entries carrying no mechanical append plan all insert plainly.
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
export function projectStatusDisplayName (status: ProjectReferenceStatus): string {
  switch (status) {
    case 'same-file':
      return 'This file'
    case 'in-active-project':
      return 'In active Project'
    case 'omitted-from-active-project':
      return 'Omitted from active Project'
    case 'another-project':
      return 'Another Project'
    case 'standalone':
      return 'Standalone document'
  }
}
