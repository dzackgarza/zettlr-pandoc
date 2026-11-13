/**
 * What the compiled TikZ preview needs from the application that shows it:
 * a TeX renderer, a URL for each rendered figure, and an error log.
 */

import type { TikzRenderSuccess } from "./live-preview";
import type { TikzRenderRequest, TikzRenderResult } from "./tikz-render";

export type TikzPreviewTheme = "light" | "dark";

export interface TikzPreviewHost {
  render: (request: TikzRenderRequest) => Promise<TikzRenderResult>;
  figureUrl: (figure: TikzRenderSuccess) => string;
  reportError: (message: string, error: unknown) => void;
}
