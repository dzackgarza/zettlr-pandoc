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
 *                  vendored tikz-editor is deliberately restricted to an
 *                  authored tikzpicture environment. The renderer shell
 *                  consumes these descriptors instead of hard-coding mode
 *                  branches.
 *
 * END HEADER
 */

import { rawTikzEnvironment, tikzBlockHasContiguousSource } from "./tikz-block";
import type { TikzLivePreviewTarget } from "./tikz-live-preview";

export type TikzPreviewModeId = "tikz" | "quiver" | "visual";

export interface TikzPreviewModeDescriptor {
  id: TikzPreviewModeId;
  label: string;
  refreshable: boolean;
  supports: (target: TikzLivePreviewTarget) => boolean;
  unavailableTitle: (target: TikzLivePreviewTarget) => string;
}

function supportsVisualEditor(target: TikzLivePreviewTarget): boolean {
  return (
    target.language === "tikz" &&
    rawTikzEnvironment(target.source) === "tikzpicture" &&
    tikzBlockHasContiguousSource(target)
  );
}

export const TIKZ_PREVIEW_MODES: readonly TikzPreviewModeDescriptor[] = [
  {
    id: "tikz",
    label: "TikZ",
    refreshable: true,
    supports: () => true,
    unavailableTitle: () => "",
  },
  {
    id: "quiver",
    label: "Quiver",
    refreshable: false,
    supports: (target) => target.language === "tikzcd" && tikzBlockHasContiguousSource(target),
    unavailableTitle: (target) =>
      target.language !== "tikzcd"
        ? "Quiver is available only for tikzcd diagrams"
        : "Move this diagram out of the surrounding Markdown block to edit it in Quiver",
  },
  {
    id: "visual",
    label: "Visual",
    refreshable: false,
    supports: supportsVisualEditor,
    unavailableTitle: (target) =>
      target.language === "tikzcd"
        ? "The visual editor is for tikzpicture diagrams; tikzcd uses Quiver"
        : !tikzBlockHasContiguousSource(target)
          ? "Move this diagram out of the surrounding Markdown block to use the visual editor"
          : "The visual editor requires a \\begin{tikzpicture} ... \\end{tikzpicture} block",
  },
];

export function defaultTikzPreviewMode(target: TikzLivePreviewTarget): TikzPreviewModeId {
  return target.language === "tikzcd" && tikzBlockHasContiguousSource(target) ? "quiver" : "tikz";
}

export function resolvedTikzPreviewMode(
  requested: TikzPreviewModeId,
  target: TikzLivePreviewTarget,
): TikzPreviewModeId {
  const descriptor = TIKZ_PREVIEW_MODES.find((mode) => mode.id === requested);
  return descriptor?.supports(target) === true ? requested : defaultTikzPreviewMode(target);
}
