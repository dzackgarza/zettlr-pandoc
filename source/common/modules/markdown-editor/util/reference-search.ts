/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Workspace reference definition search
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The pure ranking core behind Mod-P workspace definition
 *                  search (issue #1 Phase 3).
 *
 *                  CONTRACT (locked by test/reference-fzf-search.spec.ts and
 *                  test/reference-search-project-ranking.spec.ts):
 *
 *                  - Ranking is backed by the browser-safe `fzf` npm package
 *                    (import { Fzf } from 'fzf') — no shell fzf process and
 *                    no bespoke fuzzy matcher.
 *                  - The search haystack of a definition is its authored key
 *                    (e.g. 'lem:kodaira:embedding').
 *                  - The empty query reaches every workspace definition,
 *                    including duplicate definitions of the same key.
 *                  - Non-matching definitions are excluded; matching
 *                    definitions are ordered by descending fzf score, so
 *                    consecutive-substring matches rank above scattered
 *                    fuzzy matches.
 *                  - With a WorkspaceSearchContext (review A3, US-16):
 *                    current-Project definitions — same file, or listed in
 *                    the active document's Project root — rank before every
 *                    other definition, while the fzf score order is
 *                    preserved WITHIN each group. The grouping never gates:
 *                    the match set is identical with and without a context.
 *
 * END HEADER
 */

import { computeProjectReferenceStatus } from "@common/pandoc-util/project-reference-status";
import { type ProjectRootSpec, type ReferenceDefinition } from "@dts/common/references";
// NOTE: fzf is ESM-only; this must remain a real ESM import. A require()
// call resolves to an empty object at runtime.
import { Fzf } from "fzf";

/**
 * The Project context of a Mod-P search: the document the search was invoked
 * from and every visible Project root. Supplying it activates the US-16
 * current-Project-first ranking.
 */
export interface WorkspaceSearchContext {
  activeDocumentPath: string;
  projectRoots: ProjectRootSpec[];
}

/**
 * Whether a definition belongs to the searcher's current Project: its own
 * file, or a file listed in the active document's Project root.
 *
 * @param   {ReferenceDefinition}      definition  The definition
 * @param   {WorkspaceSearchContext}   context     The search context
 *
 * @return  {boolean}                              Whether the definition is current
 */
export function isCurrentProjectDefinition(
  definition: ReferenceDefinition,
  context: WorkspaceSearchContext,
): boolean {
  const status = computeProjectReferenceStatus(
    definition.documentPath,
    context.activeDocumentPath,
    context.projectRoots,
  );
  return status === "same-file" || status === "in-active-project";
}

/**
 * Ranks the workspace's reference definitions against a fuzzy query.
 *
 * The search haystack of a definition is its authored key. The empty query
 * reaches every workspace definition (including duplicate definitions of the
 * same key); non-empty queries return the fzf matches in descending score
 * order, so consecutive-substring matches rank above scattered fuzzy ones.
 * With a context, current-Project definitions rank first and the fzf order
 * is preserved within each group (review A3, US-16).
 *
 * @param   {ReferenceDefinition[]}   definitions  Every workspace definition
 * @param   {string}                  query        The typed fuzzy query
 * @param   {WorkspaceSearchContext}  context      The optional Project context
 *
 * @return  {ReferenceDefinition[]}                The ranked matches
 */
export function searchWorkspaceDefinitions(
  definitions: ReferenceDefinition[],
  query: string,
  context?: WorkspaceSearchContext,
): ReferenceDefinition[] {
  let matches: ReferenceDefinition[];
  if (query === "") {
    matches = [...definitions];
  } else {
    const fzf = new Fzf(definitions, {
      selector: (definition) => definition.key,
    });
    matches = fzf.find(query).map((result) => result.item);
  }

  if (context === undefined) {
    return matches;
  }

  // Stable partition: current-Project definitions first, everything else
  // after, each group keeping its fzf (or feed) order.
  return [
    ...matches.filter((definition) => isCurrentProjectDefinition(definition, context)),
    ...matches.filter((definition) => !isCurrentProjectDefinition(definition, context)),
  ];
}
