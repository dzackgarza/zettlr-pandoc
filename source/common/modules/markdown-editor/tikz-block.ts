/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikZ block recognition
 * CVM-Role:        Utility
 * License:         GNU GPL v3
 *
 * Description:     Owns the single editor-side definition of a supported
 *                  TikZ source block. Both the inline renderer and the
 *                  microlocal live-preview surface consume this module so
 *                  they cannot disagree about which source the user is
 *                  editing or which bytes are sent to the render service.
 *
 * END HEADER
 */

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { rawBlockLineRangesFromNode, rawBlockSourceFromNode } from "@common/util/raw-latex-block";
import {
  contiguousSourceLineRanges,
  rawTikzEnvironment,
  rawTikzInput,
  type TikzSourceBlock,
  tikzLanguageForFenceInfo,
  usesOwnedTikzTemplate,
} from "@common/util/tikz-source-blocks";
import type { SyntaxNodeRef } from "@lezer/common";

export {
  FIGURE_ENVIRONMENTS,
  INPUT_TIKZ_RE,
  rawTikzEnvironment,
  rawTikzInput,
  type TikzSourceBlock,
  tikzBlockHasContiguousSource,
  usesOwnedTikzTemplate,
} from "@common/util/tikz-source-blocks";

/**
 * Converts one Markdown syntax node into the TikZ source it represents.
 * Undefined means that node is not one of the supported figure forms.
 */
export function tikzBlockForNode(
  state: EditorState,
  node: SyntaxNodeRef,
): TikzSourceBlock | undefined {
  if (node.type.name === "RawBlock") {
    const source = rawBlockSourceFromNode(node.node, (from, to) => state.sliceDoc(from, to));
    const environment = rawTikzEnvironment(source);
    const inputPath = rawTikzInput(source);
    if (environment !== null || inputPath !== null) {
      return {
        from: node.from,
        to: node.to,
        sourceFrom: node.from,
        sourceTo: node.to,
        source,
        sourceLineRanges: rawBlockLineRangesFromNode(node.node, (from, to) =>
          state.sliceDoc(from, to),
        ),
        kind: "raw",
        language:
          environment === "tikzcd" || inputPath?.endsWith(".tikzcd") === true ? "tikzcd" : "tikz",
      };
    }

    return undefined;
  }

  if (node.type.name !== "FencedCode") {
    return undefined;
  }

  const info = node.node.getChild("CodeInfo");
  if (info === null) {
    return undefined;
  }
  const language = tikzLanguageForFenceInfo(state.sliceDoc(info.from, info.to));
  if (language === null) {
    return undefined;
  }

  const body = node.node.getChild("CodeText");
  if (body === null) {
    return undefined;
  }
  return {
    from: node.from,
    to: node.to,
    sourceFrom: body.from,
    sourceTo: body.to,
    source: state.sliceDoc(body.from, body.to),
    sourceLineRanges: contiguousSourceLineRanges(state.sliceDoc(body.from, body.to), body.from),
    kind: "fence",
    language,
  };
}

/**
 * Returns the supported TikZ block containing the main caret, if any.
 *
 * The syntax node under the caret may be a link/attribute/etc. nested inside
 * the paragraph, or CodeText inside a fenced block, so walk upward until the
 * renderer-level block node is reached rather than inspecting only the leaf.
 */
export function activeTikzBlock(state: EditorState): TikzSourceBlock | null {
  const selection = state.selection.main;
  // Rendered widgets use the editor's normal edit-first activation semantics:
  // clicking one selects the full source range. In that state the selection
  // head is exactly at the block's closing boundary, where resolveInner(...,
  // +1) belongs to whatever follows the block. Resolve from the selection's
  // inside/start edge for a non-empty selection so the sidecar and CodeMirror
  // agree that the just-activated rendered object is being edited.
  const probe = selection.empty ? selection.head : selection.from;
  const assoc = probe === state.doc.length ? -1 : 1;
  let node = syntaxTree(state).resolveInner(probe, assoc);

  while (node.parent !== null && node.type.name !== "RawBlock" && node.type.name !== "FencedCode") {
    node = node.parent;
  }

  const block = tikzBlockForNode(state, node);
  if (
    block === undefined ||
    selection.to < block.from ||
    selection.from > block.to ||
    !usesOwnedTikzTemplate(block)
  ) {
    return null;
  }
  return block;
}

/**
 * Returns the TikZ/TikZCD block containing an arbitrary document position.
 * Unlike `activeTikzBlock`, this is selection-independent and is therefore
 * suitable for completion/language services.
 */
export function tikzBlockAt(state: EditorState, pos: number): TikzSourceBlock | null {
  const bounded = Math.max(0, Math.min(pos, state.doc.length));
  for (const [probe, assoc] of [
    [bounded, -1],
    [bounded, 1],
  ] as const) {
    let node = syntaxTree(state).resolveInner(probe, assoc);
    while (
      node.parent !== null &&
      node.type.name !== "RawBlock" &&
      node.type.name !== "FencedCode"
    ) {
      node = node.parent;
    }
    const block = tikzBlockForNode(state, node);
    if (block !== undefined && bounded >= block.sourceFrom && bounded <= block.sourceTo) {
      return block;
    }
  }
  return null;
}
