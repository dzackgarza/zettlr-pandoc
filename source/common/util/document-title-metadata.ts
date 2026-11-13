import { extractASTNodes, extractTextnodes, markdownToAST } from "@common/modules/markdown-utils";
import type { ASTNode, Heading } from "@common/modules/markdown-utils/markdown-ast";

export interface DocumentTitleMetadata {
  firstHeading: string | null;
  firstSentence: string | null;
}

function proseUntilMath(nodes: ASTNode[]): string {
  const parts: string[] = [];

  function visit(node: ASTNode): boolean {
    if (node.type === "Text") {
      parts.push(node.whitespaceBefore + node.value);
      return true;
    }

    if (node.type === "InlineCode") {
      // MathTeX carries a non-empty info marker. Stop rather than concatenating
      // prose from opposite sides of math into an incoherent fallback title.
      return node.info === "";
    }

    if (node.type === "Link" || node.type === "Image") {
      parts.push(node.alt.whitespaceBefore + node.alt.value);
      return true;
    }

    if (
      node.type === "Generic" ||
      node.type === "Emphasis" ||
      node.type === "Highlight" ||
      node.type === "Strikethrough" ||
      node.type === "Superscript" ||
      node.type === "Subscript" ||
      node.type === "PandocSpan"
    ) {
      for (const child of node.children) {
        if (!visit(child)) return false;
      }
    }

    return true;
  }

  for (const node of nodes) {
    if (!visit(node)) break;
  }

  return parts.join("").replace(/\s+/gu, " ").trim();
}

export function documentTitleMetadataFromAST(ast: ASTNode): DocumentTitleMetadata {
  if (ast.type !== "Document") {
    return { firstHeading: null, firstSentence: null };
  }
  // The grammar reads a Setext heading as Pandoc does: math over the `=`
  // line makes no heading (#203)
  const [firstHeadingNode] = extractASTNodes(ast, "Heading") as Heading[];
  const firstHeading =
    firstHeadingNode === undefined
      ? null
      : titleCandidate(
          extractTextnodes(firstHeadingNode)
            .map((node) => node.whitespaceBefore + node.value)
            .join(""),
        );

  const paragraph = ast.children.find(
    (node) => node.type === "Generic" && node.name === "Paragraph",
  );
  if (paragraph === undefined || paragraph.type !== "Generic") {
    return { firstHeading, firstSentence: null };
  }

  const prose = proseUntilMath(paragraph.children);
  if (prose === "") {
    return { firstHeading, firstSentence: null };
  }

  const firstSentence = prose.match(/^.*?[.!?](?=\s|$)/u)?.[0] ?? prose;
  return { firstHeading, firstSentence: titleCandidate(firstSentence) };
}

/** A heading or sentence that is only whitespace offers no title. */
function titleCandidate(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

export function documentTitleMetadata(content: string): DocumentTitleMetadata {
  return documentTitleMetadataFromAST(markdownToAST(content));
}
