/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Pandoc fenced-div model and semantic classification
 * CVM-Role:        Utility
 * Maintainer:      Bennie Milburn
 * License:         GNU GPL v3
 *
 * Description:     Builds a structural model of a Pandoc fenced div (ranges,
 *                  attributes, semantic family) from a Lezer syntax node.
 *                  Viewport- and view-independent so the same model serves the
 *                  editor renderer and whole-document consumers such as the
 *                  workspace reference index.
 *
 * END HEADER
 */

import type { SyntaxNode } from "@lezer/common";
import { parsePandocAttributes } from "./parse-pandoc-attributes";

export type PandocDivFamily =
  | "result"
  | "definition"
  | "explanation"
  | "task"
  | "warning"
  | "proof"
  | "generic";

export interface PandocDivModel {
  from: number;
  to: number;
  openFrom: number;
  openTo: number;
  contentFrom: number;
  contentTo: number;
  closeFrom: number;
  closeTo: number;
  classes: string[];
  id: string;
  properties: Record<string, string>;
  family: PandocDivFamily;
  label: string;
  depth: number;
}

/**
 * The minimal document surface the model builder needs. CodeMirror's `Text`
 * (i.e. `state.doc`) satisfies this directly; other consumers can adapt a
 * plain string. Kept structural so this module never imports the editor graph.
 */
export interface DivSourceDocument {
  lineAt: (pos: number) => { from: number; to: number };
  sliceString: (from: number, to: number) => string;
}

export const SEMANTIC_DIV_CLASSES: Record<string, PandocDivFamily> = {
  theorem: "result",
  lemma: "result",
  proposition: "result",
  corollary: "result",
  conjecture: "result",
  claim: "result",
  definition: "definition",
  construction: "definition",
  notation: "definition",
  assumption: "definition",
  example: "explanation",
  remark: "explanation",
  observation: "explanation",
  fact: "explanation",
  exercise: "task",
  problem: "task",
  question: "task",
  warning: "warning",
  caution: "warning",
  danger: "warning",
  error: "warning",
  proof: "proof",
  sketch: "proof",
  solution: "proof",
};

export function humanizeClassName(className: string): string {
  return className.replace(/[._-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function classifyDiv(classes: string[]): { family: PandocDivFamily; label: string } {
  for (const authoredClass of classes) {
    const normalizedClass = authoredClass.toLowerCase();
    const family = SEMANTIC_DIV_CLASSES[normalizedClass];
    if (family !== undefined) {
      return { family, label: humanizeClassName(normalizedClass) };
    }
  }

  return {
    family: "generic",
    label: classes.length > 0 ? `.${classes[0]}` : "Div",
  };
}

/**
 * Restricts authored properties to those safe to project onto DOM elements.
 */
export function safeProperties(
  properties: Record<string, string> | undefined,
): Record<string, string> {
  if (properties === undefined) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(properties).filter(([name]) => {
      return (
        name === "role" || name === "title" || name.startsWith("aria-") || name.startsWith("data-")
      );
    }),
  );
}

export function divModelFromNode(
  doc: DivSourceDocument,
  node: SyntaxNode,
): PandocDivModel | undefined {
  const marks = node.getChildren("PandocDivMark");
  const attrs = node.getChild("PandocAttribute");
  const info = node.getChild("PandocDivInfo");

  if ((!attrs && !info) || marks.length !== 2) {
    return undefined;
  }

  const openingLine = doc.lineAt(node.from);
  const closingLine = doc.lineAt(node.to);
  const contentFrom = Math.min(openingLine.to + 1, closingLine.from);
  const attributes = attrs ? parsePandocAttributes(doc.sliceString(attrs.from, attrs.to)) : {};
  const classes = info ? [doc.sliceString(info.from, info.to)] : [];
  if (attributes.classes) {
    classes.push(...attributes.classes);
  }

  const classification = classifyDiv(classes);
  let depth = 0;
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (parent.name === "PandocDiv") {
      depth++;
    }
  }
  return {
    from: node.from,
    to: node.to,
    openFrom: openingLine.from,
    openTo: openingLine.to,
    contentFrom,
    contentTo: Math.max(contentFrom, closingLine.from - 1),
    closeFrom: closingLine.from,
    closeTo: closingLine.to,
    classes,
    id: attributes.id ?? "",
    properties: safeProperties(attributes.properties),
    depth,
    ...classification,
  };
}
