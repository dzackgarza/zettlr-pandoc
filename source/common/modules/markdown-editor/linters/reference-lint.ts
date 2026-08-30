/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Reference Linter
 * CVM-Role:        Linter
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Diagnostics for workspace reference contradictions
 *                  (issue #1 Phase 4), following the md-lint linter()
 *                  archetype (./md-lint.ts).
 *
 *                  CONTRACT (locked by test/reference-lint.spec.ts):
 *
 *                  - referenceLintSource() is the linter source and is
 *                    exported for direct headless driving. The current
 *                    document's definitions and occurrences come from
 *                    workspaceReferencesField.snapshot; resolutions and the
 *                    citing index come from the same field. While the field
 *                    is null the linter reports nothing.
 *                  - DUPLICATE KEYS: every definition in this document whose
 *                    key resolves to 'duplicate' receives an ERROR at the
 *                    definition's authored id range whose message lists ALL
 *                    definition sites (every documentPath in the
 *                    resolution's definitions), never a silently selected
 *                    subset.
 *                  - MISSING REFERENCES: every occurrence in this document
 *                    whose key resolves to 'missing' receives a WARNING at
 *                    the occurrence's authored range naming the missing key.
 *                    The message MAY offer compatible existing keys as
 *                    replacement candidates, but every family-prefixed key
 *                    it mentions must be either the missing key itself or a
 *                    key actually defined in the workspace — the linter
 *                    never fabricates targets.
 *                  - CLASS/PREFIX MISMATCH: a theorem-div definition whose
 *                    div class and id prefix disagree (e.g. div class
 *                    `lemma` with id `thm:foo`) receives an ERROR at the
 *                    authored id range naming BOTH conflicting values and a
 *                    valid example (e.g. `#lem:foo` per the
 *                    theorem-family metadata). The linter never guesses
 *                    which side the author meant and never rewrites either.
 *                  - PROOF-DIV ID: an id attribute on a proof-like div
 *                    (which defines no target) receives an INFO diagnostic
 *                    at the authored id token explaining that proofs are
 *                    unreferenceable.
 *                  - MIXED CLUSTER ADVISORY: a citation cluster mixing
 *                    bibliography keys and supported-family reference keys
 *                    stays raw in the editor and receives a WARNING spanning
 *                    the whole authored cluster.
 *                  - NO AUTO-FIX: no diagnostic ever carries actions of any
 *                    kind.
 *
 * END HEADER
 */

import { linter, type Diagnostic } from '@codemirror/lint'
import { type EditorView } from '@codemirror/view'
import { markdownToAST } from '@common/modules/markdown-utils'
import type { ASTNode } from '@common/modules/markdown-utils/markdown-ast'
import { locateAttribute } from '@common/pandoc-util/extract-references'
import { SEMANTIC_DIV_CLASSES } from '@common/pandoc-util/pandoc-div-model'
import { THEOREM_FAMILY_METADATA, REFERENCEABLE_DIV_CLASSES } from '@common/util/pandoc-quick-reference'
import { referenceFamilyOf, referenceKeyParts, type ReferenceFamily } from '@dts/common/references'
import { workspaceReferencesField, type EditorWorkspaceReferences } from '../plugins/workspace-references-field'

/**
 * The label prefix of each referenceable div class, inverted from the fixed
 * theorem-family registry ('lemma' -> 'lem').
 */
const CLASS_TO_PREFIX: Record<string, string> = Object.fromEntries(
  THEOREM_FAMILY_METADATA.map(metadata => [ metadata.divClass, metadata.prefix ])
)

/**
 * The comparable remainder tokens of a key ('lem:kodaira:embedding' ->
 * ['kodaira', 'embedding']), used to offer existing keys as candidates.
 */
function remainderTokens (key: string): string[] {
  return (referenceKeyParts(key)?.remainder ?? key)
    .toLowerCase()
    .split(/[:_-]+/)
    .filter(token => token !== '')
}

/**
 * Offers compatible existing keys as replacement candidates for a missing
 * key: same-family keys actually defined in the workspace that share at
 * least one remainder token. The linter never fabricates targets.
 *
 * @param   {string}                     missingKey  The missing key
 * @param   {ReferenceFamily}            family      The missing key's family
 * @param   {EditorWorkspaceReferences}  references  The workspace view
 *
 * @return  {string[]}                               Defined candidate keys
 */
function candidatesFor (missingKey: string, family: ReferenceFamily, references: EditorWorkspaceReferences): string[] {
  const tokens = new Set(remainderTokens(missingKey))
  const candidates: string[] = []

  for (const [ key, resolution ] of references.resolutions) {
    if (key === missingKey || resolution.status === 'missing') {
      continue // Only keys actually defined somewhere qualify.
    }

    if (referenceFamilyOf(key) !== family) {
      continue
    }

    if (remainderTokens(key).some(token => tokens.has(token))) {
      candidates.push(key)
    }
  }

  return candidates.sort()
}

/**
 * Walks every node of the given AST in document order.
 */
function walkAST (node: ASTNode, visit: (node: ASTNode) => void): void {
  visit(node)

  const children = 'children' in node
    ? node.children
    : 'items' in node
      ? node.items
      : 'rows' in node
        ? node.rows
        : 'cells' in node
          ? node.cells
          : []

  for (const child of children) {
    walkAST(child, visit)
  }
}

/**
 * Collects the AST-derived diagnostics of the current buffer: ids on
 * proof-like divs and mixed bibliography/reference citation clusters.
 *
 * The id-token locator is the extractor's own exported locateAttribute
 * (review B6) — one authority, not a parallel copy. Its fail-loud contract
 * is kept deliberately: an inconsistent attribute block (parsed id absent
 * from the authored text) is a parser bug, and the resulting throw
 * propagates out of the lint source instead of silently dropping the
 * diagnostic — the condition is not reachable through authored input.
 */
function collectASTDiagnostics (markdown: string, diagnostics: Diagnostic[]): void {
  walkAST(markdownToAST(markdown), node => {
    if (node.type === 'PandocDiv') {
      const openLineEnd = markdown.indexOf('\n', node.from)
      const openLine = markdown.slice(node.from, openLineEnd === -1 || openLineEnd > node.to ? node.to : openLineEnd)
      const brace = openLine.indexOf('{')
      if (brace === -1) {
        return
      }

      const located = locateAttribute(openLine.slice(brace), node.from + brace)
      if (located === undefined) {
        return
      }

      const classes = located.attributes.classes ?? []
      const isProofLike = classes.some(divClass => SEMANTIC_DIV_CLASSES[divClass.toLowerCase()] === 'proof')
      if (isProofLike) {
        diagnostics.push({
          from: located.range.from,
          to: located.range.to,
          severity: 'info',
          message: `The id "#${located.key}" on a proof div defines no reference target: proofs stay unnumbered and unreferenceable.`,
          source: 'reference-lint'
        })
      }
    } else if (node.type === 'Citation') {
      const items = node.parsedCitation.items
      const supported = items.filter(item => referenceFamilyOf(item.id) !== undefined).length
      if (supported > 0 && supported < items.length) {
        diagnostics.push({
          from: node.from,
          to: node.to,
          severity: 'warning',
          message: 'This cluster mixes bibliography citations with cross-references, so it stays raw: it renders neither as a citation nor as reference chips. Split it into separate clusters.',
          source: 'reference-lint'
        })
      }
    }
  })
}

/**
 * Collects the snapshot-derived diagnostics: duplicate definitions, missing
 * occurrences, and theorem-div class/prefix mismatches.
 */
function collectSnapshotDiagnostics (references: EditorWorkspaceReferences, diagnostics: Diagnostic[]): void {
  for (const definition of references.snapshot.definitions) {
    const resolution = references.resolutions.get(definition.key)

    if (resolution?.status === 'duplicate') {
      const sites = resolution.definitions.map(site => site.documentPath)
      diagnostics.push({
        from: definition.range.from,
        to: definition.range.to,
        severity: 'error',
        message: `The reference key "${definition.key}" is defined more than once. Definition sites: ${sites.join(', ')}. Every key must be unique across the workspace.`,
        source: 'reference-lint'
      })
    }

    if (definition.sourceKind === 'theorem-div') {
      // The authored classes ride on the definition itself (review B6):
      // previewSource is a display excerpt and is never re-parsed here.
      const referenceableClasses = definition.classes.filter(divClass => REFERENCEABLE_DIV_CLASSES.includes(divClass.toLowerCase()))
      const authoredClass = referenceableClasses.length > 0 ? referenceableClasses[0].toLowerCase() : undefined
      const expectedPrefix = authoredClass !== undefined ? CLASS_TO_PREFIX[authoredClass] : undefined
      if (authoredClass !== undefined && expectedPrefix !== undefined && definition.family !== expectedPrefix) {
        const parts = referenceKeyParts(definition.key)
        const separator = parts?.separator ?? ':'
        const remainder = parts?.remainder ?? definition.key
        const example = `#${expectedPrefix}${separator}${remainder}`
        diagnostics.push({
          from: definition.range.from,
          to: definition.range.to,
          severity: 'error',
          message: `The div class "${authoredClass}" conflicts with the id "#${definition.key}": a ${authoredClass} div uses the "${expectedPrefix}" family, e.g. "${example}". Change one side to match the other.`,
          source: 'reference-lint'
        })
      }
    }
  }

  for (const occurrence of references.snapshot.occurrences) {
    const resolution = references.resolutions.get(occurrence.key)
    if (resolution?.status !== 'missing') {
      continue
    }

    const candidates = candidatesFor(occurrence.key, occurrence.family, references)
    const suffix = candidates.length > 0
      ? ` Did you mean ${candidates.join(', ')}?`
      : ''
    diagnostics.push({
      from: occurrence.range.from,
      to: occurrence.range.to,
      severity: 'warning',
      message: `The reference "@${occurrence.key}" is not defined anywhere in the workspace.${suffix}`,
      source: 'reference-lint'
    })
  }
}

/**
 * The diagnostic source for workspace reference lint: the specs drive this
 * function directly against a real EditorView.
 *
 * @param   {EditorView}  view  The editor view
 *
 * @return  {Promise<Diagnostic[]>}  The reference diagnostics
 */
export async function referenceLintSource (view: EditorView): Promise<Diagnostic[]> {
  const references = view.state.field(workspaceReferencesField, false) ?? null
  if (references === null) {
    return [] // No workspace view yet: the linter reports nothing.
  }

  const diagnostics: Diagnostic[] = []
  collectSnapshotDiagnostics(references, diagnostics)
  collectASTDiagnostics(view.state.doc.toString(), diagnostics)

  return diagnostics.sort((a, b) => a.from - b.from || a.to - b.to)
}

export const referenceLint = linter(referenceLintSource)
