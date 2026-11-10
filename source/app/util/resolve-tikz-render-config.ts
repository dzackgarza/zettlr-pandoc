import {
  resolveTikzDataDir,
  resolveTikzTemplatePath,
  type TikzRenderConfig,
} from "@dzack/tikz-render/tikz-render";
import path from "path";
import { resolveCentralFiguresDirectory } from "./central-figures-store";

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
    env,
  };
}
