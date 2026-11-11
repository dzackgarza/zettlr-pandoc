import {
  resolveTikzDataDir,
  resolveTikzTemplatePath,
  type TikzRenderConfig,
} from "@dzack/tikz-render/tikz-render";
import path from "path";
import { resolveCentralFiguresDirectory } from "./central-figures-store";

/**
 * The time that the app gives one TikZ render. A figure of a document
 * compiles in seconds; a render that takes this long has a TeX loop that does
 * not end.
 */
const TIKZ_RENDER_TIMEOUT_MS = 30_000;

export function resolveTikzRenderConfig(
  configuredDataDir: string,
  configuredFiguresDir: string,
  homeDirectory: string,
  userDataDirectory: string,
  env: NodeJS.ProcessEnv,
): TikzRenderConfig {
  return {
    tikzAssetDir: resolveTikzDataDir(configuredDataDir, homeDirectory),
    templatePath: resolveTikzTemplatePath(homeDirectory),
    figuresSourceDir: resolveCentralFiguresDirectory(configuredFiguresDir, homeDirectory, env),
    cacheDir: path.join(userDataDirectory, "tikz-cache"),
    timeoutMs: TIKZ_RENDER_TIMEOUT_MS,
    env,
  };
}
