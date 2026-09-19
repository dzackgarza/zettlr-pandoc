/**
 * Presentation helpers for compiler output returned by the TikZ render
 * service.  They never invent diagnostics: every displayed line is copied
 * from the captured Pandoc/TeX stderr stream.
 */

const MACHINE_LINE = /^\[tikzcd-(?:figure-error|pdflatex-log-(?:begin|end))\]/u;
const SALIENT_LINE =
  /(?:^!\s|error|fatal|undefined|not found|emergency stop|runaway argument|capacity exceeded|missing)/iu;

function normalizedLines(log: string): string[] {
  return log
    .replace(/\x1b\[[0-9;]*m/gu, "")
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+$/u, ""));
}

/**
 * Return a bounded excerpt centered on actual TeX error blocks.  When the log
 * contains no recognizable error marker, return its final non-empty lines
 * rather than replacing the compiler output with a canned explanation.
 */
export function tikzCompilerLogExcerpt(log: string, maxLines = 24): string {
  if (log.trim() === "") {
    return "";
  }
  const lines = normalizedLines(log);
  const selected = new Set<number>();

  for (let index = 0; index < lines.length; index++) {
    if (!SALIENT_LINE.test(lines[index])) {
      continue;
    }
    const from = Math.max(0, index - 1);
    const to = Math.min(lines.length, index + 5);
    for (let probe = from; probe < to; probe++) {
      selected.add(probe);
    }
  }

  let excerpt =
    selected.size > 0
      ? [...selected].sort((a, b) => a - b).map((index) => lines[index])
      : lines.filter((line) => line.trim() !== "" && !MACHINE_LINE.test(line)).slice(-maxLines);

  excerpt = excerpt.filter((line) => !MACHINE_LINE.test(line));
  if (excerpt.length > maxLines) {
    excerpt = excerpt.slice(0, maxLines);
  }
  return excerpt.join("\n").trim();
}

/** The first meaningful compiler line suitable for a compact status row. */
export function tikzCompilerLogHeadline(log: string): string {
  const excerpt = tikzCompilerLogExcerpt(log, 12);
  if (excerpt === "") {
    return "";
  }
  const lines = excerpt.split("\n");
  const salient =
    lines.find((line) => SALIENT_LINE.test(line)) ?? lines.find((line) => line.trim() !== "") ?? "";
  return salient.trim();
}
