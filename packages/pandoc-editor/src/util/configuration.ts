import { type EditorState, Facet } from "@codemirror/state";

/** Presentation values supplied by the host's configuration state. */
export interface PreviewConfiguration {
  previewModeShowSyntaxWhenCursorIsAdjacent: boolean;
}

/** The host gives its preview configuration through this facet. */
export const previewConfig = Facet.define<PreviewConfiguration>();

/** The preview configuration of the host. An editor without one is a host error. */
export function previewConfiguration(state: EditorState): PreviewConfiguration {
  const configurations = state.facet(previewConfig);
  if (configurations.length === 0) {
    throw new Error("The renderers require the preview configuration of the host.");
  }
  return configurations[0];
}
