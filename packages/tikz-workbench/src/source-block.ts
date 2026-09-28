/**
 * The TikZ source a workbench edits: one figure's bytes and where they sit in
 * the host's document. A host that stores a whole .tikz file supplies the file
 * as one block; a Markdown host supplies one raw or fenced block.
 */

export const FIGURE_ENVIRONMENTS: ReadonlySet<string> = new Set(["tikzcd", "tikzpicture"]);

export interface TikzSourceBlock {
  from: number;
  to: number;
  sourceFrom: number;
  sourceTo: number;
  source: string;
  sourceLineRanges: ReadonlyArray<{ from: number; to: number }>;
  kind: "raw" | "fence";
  language: "tikz" | "tikzcd";
}

export function contiguousSourceLineRanges(
  source: string,
  sourceFrom: number,
): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  let offset = 0;
  for (const line of source.split("\n")) {
    ranges.push({
      from: sourceFrom + offset,
      to: sourceFrom + offset + line.length,
    });
    offset += line.length + 1;
  }
  return ranges;
}

/**
 * Whether the semantic TikZ source is stored as one contiguous authored range.
 * Raw blocks inside Markdown containers (for example blockquotes and list
 * items) may omit container markers from their semantic source; those blocks
 * are renderable but cannot safely be replaced wholesale by a visual editor.
 */
export function tikzBlockHasContiguousSource(block: TikzSourceBlock): boolean {
  if (block.sourceLineRanges.length === 0) {
    return block.source.length === 0 && block.sourceFrom === block.sourceTo;
  }
  if (
    block.sourceLineRanges[0].from !== block.sourceFrom ||
    block.sourceLineRanges[block.sourceLineRanges.length - 1].to !== block.sourceTo
  ) {
    return false;
  }

  let semanticLength = 0;
  for (let index = 0; index < block.sourceLineRanges.length; index += 1) {
    const range = block.sourceLineRanges[index];
    semanticLength += range.to - range.from;
    if (index > 0) {
      const previous = block.sourceLineRanges[index - 1];
      if (range.from !== previous.to + 1) {
        return false;
      }
      semanticLength += 1;
    }
  }
  return semanticLength === block.source.length;
}

const ENVIRONMENT_OPEN_RE = /^\\begin\{([A-Za-z]+\*?)\}/u;

/**
 * The figure environment if `text` (ignoring trailing whitespace) is exactly
 * one `\begin{name}…\end{name}` block of a supported figure environment.
 */
export function rawTikzEnvironment(text: string): string | null {
  const match = ENVIRONMENT_OPEN_RE.exec(text);
  if (match === null || !text.trimEnd().endsWith(`\\end{${match[1]}}`)) {
    return null;
  }
  return FIGURE_ENVIRONMENTS.has(match[1]) ? match[1] : null;
}
