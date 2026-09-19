import path from "path";
import { resolveCentralFiguresDirectory } from "./central-figures-store";
import { resolveTikzDataDir, resolveTikzTemplatePath, type TikzRenderConfig } from "./tikz-render";

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
