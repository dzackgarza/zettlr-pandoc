import { mkdir, mkdtemp, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import {
  createDocumentLintContext,
  type DocumentLintSharedContext,
} from "source/app/util/document-lint";
import { readTexCommandVocabulary } from "source/app/util/flowmark-tex-vocabulary";
import type { TexCommandVocabulary } from "source/types/common/tex-vocabulary";

/** A home whose central macro tree is one file, and the lint context of it. */
export interface TexVocabularyHome {
  home: string;
  context: DocumentLintSharedContext;
  /** The answer of the `tex-command-vocabulary` command for this home. */
  vocabulary: TexCommandVocabulary;
}

/**
 * The TeX vocabulary that the installed Flowmark gives for a home whose
 * central macro tree is one file with `macroText`. The caller removes `home`.
 */
export async function flowmarkTexVocabulary(
  macroFile: string,
  macroText: string,
): Promise<TexVocabularyHome> {
  const home = await mkdtemp(path.join(os.tmpdir(), "zettlr-tex-vocabulary-"));
  await mkdir(path.join(home, ".pandoc", "styles", "macros"), { recursive: true });
  await mkdir(path.join(home, ".pandoc", "templates", "css"), { recursive: true });
  await writeFile(path.join(home, ".pandoc", "styles", "macros", macroFile), macroText);
  await writeFile(path.join(home, ".pandoc", "templates", "css", "mathjax-macros.json"), "{}");
  const context = await createDocumentLintContext({
    homeDirectory: home,
    env: process.env,
    flowmarkLintTimeoutMs: 60_000,
    tikzRenderConfig: {
      tikzAssetDir: path.join(home, "tikz"),
      timeoutMs: 30_000,
      templatePath: path.join(home, "tikz-template.tex"),
      cacheDir: path.join(home, "tikz-cache"),
      env: process.env,
    },
  });
  return { home, context, vocabulary: await readTexCommandVocabulary(context) };
}
