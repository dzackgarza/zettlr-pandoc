/** Editor-neutral diagnostic shape shared by renderer lint and HTTP lint. */

export type SourceLintSeverity = "info" | "warning" | "error";

export interface SourceLintDiagnostic {
  from: number;
  to: number;
  severity: SourceLintSeverity;
  message: string;
  source: string;
  rule?: string;
  data?: Record<string, unknown>;
}
