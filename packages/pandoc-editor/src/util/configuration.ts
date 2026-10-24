import { Facet } from "@codemirror/state";

/** Presentation values supplied by the host's configuration state. */
export interface PreviewConfiguration {
  previewModeShowSyntaxWhenCursorIsAdjacent: boolean;
}

export const previewConfig = Facet.define<PreviewConfiguration, PreviewConfiguration>({
  combine: (values) => values[0] ?? { previewModeShowSyntaxWhenCursorIsAdjacent: true },
});
