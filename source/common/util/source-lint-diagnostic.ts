/** Editor-neutral diagnostic shape shared by renderer lint and HTTP lint. */

export type SourceLintSeverity = "info" | "warning" | "error";

export interface SourceLintDiagnostic {
  from: number;
  to: number;
  severity: SourceLintSeverity;
  message: string;
  source: string;
  rule?: string;
  /** Candidate fixes; each replaces the whole `from`–`to` range. */
  suggestions?: { title: string; replacement: string }[];
  data?: Record<string, unknown>;
}
