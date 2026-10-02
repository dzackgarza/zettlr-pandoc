/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikZ preview-mode capability model
 * CVM-Role:        Domain
 * License:         GNU GPL v3
 *
 * Description:     Declares the preview/editor modes which may host one active
 *                  TikZ source block. Availability is source-semantic rather
 *                  than a view concern: tikzcd may use Quiver, while the
 *                  vendored tikz-editor needs source that contains a
 *                  tikzpicture environment. The renderer shell
 *                  consumes these descriptors instead of hard-coding mode
 *                  branches.
 *
 * END HEADER
 */

import type { TikzLivePreviewTarget } from "./live-preview";
import { quiverCanEditBlock, quiverSourceError } from "./quiver-bridge";
import { tikzBlockHasContiguousSource } from "./source-block";

export type TikzPreviewModeId = "tikz" | "quiver" | "visual";

export interface TikzPreviewModeDescriptor {
  id: TikzPreviewModeId;
  label: string;
  refreshable: boolean;
  supports: (target: TikzLivePreviewTarget) => boolean;
  unavailableTitle: (target: TikzLivePreviewTarget) => string;
}

// tikz-editor edits a whole TikZ file: setup before the environment and
// comments after it are part of the source it round-trips.
const TIKZPICTURE_RE = /\\begin\{tikzpicture\}[\s\S]*\\end\{tikzpicture\}/u;

function supportsVisualEditor(target: TikzLivePreviewTarget): boolean {
  return (
    target.language === "tikz" &&
    TIKZPICTURE_RE.test(target.source) &&
    tikzBlockHasContiguousSource(target)
  );
}

export const TIKZ_PREVIEW_MODES: readonly TikzPreviewModeDescriptor[] = [
  {
    id: "tikz",
    label: "Compiled preview",
    refreshable: true,
    supports: () => true,
    unavailableTitle: () => "",
  },
  {
    id: "quiver",
    label: "Quiver editor",
    refreshable: false,
    supports: quiverCanEditBlock,
    unavailableTitle: (target) => {
      const error = quiverSourceError(target);
      if (error === null) {
        throw new Error("Quiver can edit this block, so it has no unavailable title");
      }
      return error;
    },
  },
  {
    id: "visual",
    label: "Visual editor",
    refreshable: false,
    supports: supportsVisualEditor,
    unavailableTitle: (target) =>
      target.language === "tikzcd"
        ? "The visual editor is for tikzpicture diagrams; tikzcd uses Quiver"
        : !tikzBlockHasContiguousSource(target)
          ? "Move this diagram out of the surrounding Markdown block to use the visual editor"
          : "The visual editor requires a \\begin{tikzpicture} ... \\end{tikzpicture} environment",
  },
];

export function defaultTikzPreviewMode(target: TikzLivePreviewTarget): TikzPreviewModeId {
  return target.language === "tikzcd" ? "quiver" : "tikz";
}
