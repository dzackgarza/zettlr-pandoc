/**
 * The wire contract of Fix All: the renderer asks for a plan over a scope,
 * shows its summary, and commits the same plan.
 */

export type FixAllRequest =
  | { scope: 'document', documentPath: string }
  | { scope: 'open' }
  | { scope: 'workspace' }

/** One machine-applicable fix, in the offsets of the text it was planned on. */
export interface FixAllEdit {
  from: number
  to: number
  insert: string
  rule: string
}

export interface FixAllDocument {
  documentPath: string
  /** hashDocumentSource of the text the edits were planned on. */
  sourceHash: string
  edits: FixAllEdit[]
}

export interface FixAllPlan {
  /** The documents with at least one fix. */
  documents: FixAllDocument[]
  /** How many documents the scope held. */
  documentsChecked: number
  /** The documents Flowmark could not lint, so their fixes are unknown. */
  unlinted: string[]
}

export type FixAllOutcome =
  | { status: 'applied', fixesApplied: number, documentsChanged: string[] }
  | { status: 'conflict', documentPath: string }
