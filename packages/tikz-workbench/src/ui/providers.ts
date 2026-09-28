/**
 * Binds the preview-mode descriptors to their components. The workbench shell
 * consumes only this registry, so a new preview or editor needs no further
 * rendering branch in the shell.
 */

import type { Component } from "vue";
import {
  TIKZ_PREVIEW_MODES,
  type TikzPreviewModeDescriptor,
  type TikzPreviewModeId,
} from "../preview-modes";
import TikzCompilerPreview from "./TikzCompilerPreview.vue";
import TikzEditorPreview from "./TikzEditorPreview.vue";
import TikzQuiverPreview from "./TikzQuiverPreview.vue";

export interface TikzPreviewProvider extends TikzPreviewModeDescriptor {
  component: Component;
}

const COMPONENTS: Record<TikzPreviewModeId, Component> = {
  tikz: TikzCompilerPreview,
  quiver: TikzQuiverPreview,
  visual: TikzEditorPreview,
};

export const TIKZ_PREVIEW_PROVIDERS: readonly TikzPreviewProvider[] = TIKZ_PREVIEW_MODES.map(
  (mode) => ({ ...mode, component: COMPONENTS[mode.id] }),
);
