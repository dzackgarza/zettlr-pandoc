/**
 * Splits captured subprocess output into non-empty lines for ExporterOutput's
 * stdout/stderr arrays.
 */
export const splitLines = (text: string): string[] =>
  text.split("\n").filter((line) => line.trim() !== "");
