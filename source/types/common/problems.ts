export type ProblemScope = "workspace" | "all";
export type ProblemSeverity = "error" | "warning" | "info";

export interface ProblemFinding {
  severity: ProblemSeverity;
  rule: string;
  source: string;
  message: string;
  line: number;
  column: number;
  from: number;
  to: number;
  fix: { title: string; replacement: string } | null;
}

export interface ProblemDocument {
  path: string;
  name: string;
  state: "current" | "stale";
  sourceHash: string;
  diagnostics: ProblemFinding[];
  counts: Record<ProblemSeverity, number>;
}

/** A document without a lint result: its last run failed, or its file gave no text. */
export interface UnlintedDocument {
  path: string;
  name: string;
  /** Why the document has no result. */
  cause: string;
}

export interface WorkspaceProblems {
  documents: ProblemDocument[];
  /** The documents that wait for their first result. */
  pendingPaths: string[];
  /** The documents whose current text has no lint result, each with the cause. */
  failed: UnlintedDocument[];
  /** Why the background queue lints no document; null while it works. */
  queueStopped: string | null;
  documentCount: number;
  queueActive: boolean;
}

export interface ListProblemsRequest {
  scope: ProblemScope;
  workspacePath?: string;
}

export interface ApplyProblemFixRequest {
  documentPath: string;
  sourceHash: string;
  from: number;
  to: number;
  replacement: string;
}
