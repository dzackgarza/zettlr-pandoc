/**
 * Select a real TeX error for the status row. The full log stays in the view.
 * A log with no line other than tikzcd progress markers has no headline.
 */
export function tikzCompilerLogHeadline(log: string): string | null {
  const lines = log
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const texError = lines.find((line) => line.startsWith("! "));
  if (texError !== undefined) return texError;
  const toolError = lines.find((line) =>
    /(?:^|\s)(?:Error:|error:|Fatal error|not found|exited unexpectedly|failed|terminated)/u.test(
      line,
    ),
  );
  if (toolError !== undefined) return toolError;
  const firstLine = lines.find((line) => !line.startsWith("[tikzcd-"));
  return firstLine === undefined ? null : firstLine;
}
