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

export interface WorkspaceProblems {
  documents: ProblemDocument[];
  pendingPaths: string[];
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
