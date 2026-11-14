/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The TeX vocabulary of Flowmark
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Asks the installed `flowmark-lint` for its TeXstudio
 *                  command index and for the packages that the `tex` lint
 *                  context loads, and reads that index. The TeX command
 *                  completion of the editor offers the commands that
 *                  `tex/unknown-command` accepts, from the same data (#118).
 *
 * END HEADER
 */

import type { TexCommandVocabulary, TexstudioCommandIndex } from "@dts/common/tex-vocabulary";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import type { DocumentLintSharedContext } from "./document-lint";
import { flowmarkTexContext } from "./flowmark-lint-context";
import { runFlowmarkProcess } from "./flowmark-runtime";

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function texstudioIndex(value: unknown): value is TexstudioCommandIndex {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<TexstudioCommandIndex>;
  if (
    candidate.schema !== 1 ||
    typeof candidate.source?.repository !== "string" ||
    typeof candidate.source.commit !== "string" ||
    !stringList(candidate.core) ||
    typeof candidate.packages !== "object" ||
    candidate.packages === null
  ) {
    return false;
  }
  return Object.values(candidate.packages).every(
    (entry) => stringList(entry.commands) && stringList(entry.includes),
  );
}

interface VocabularyAnswer {
  version: 1;
  index: string;
  packages: string[];
}

function vocabularyAnswer(value: unknown): value is VocabularyAnswer {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<VocabularyAnswer>;
  return (
    candidate.version === 1 && typeof candidate.index === "string" && stringList(candidate.packages)
  );
}

/**
 * The TeX vocabulary of the lint context: Flowmark's index and the packages
 * that the context loads. Throws with the cause when Flowmark does not answer
 * or its answer or its index cannot be read.
 */
export async function readTexCommandVocabulary(
  context: DocumentLintSharedContext,
): Promise<TexCommandVocabulary> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zettlr-flowmark-tex-"));
  const contextPath = path.join(directory, "context.json");
  let outcome;
  try {
    await writeFile(
      contextPath,
      JSON.stringify({ tex: flowmarkTexContext(context, undefined) }),
      "utf8",
    );
    outcome = await runFlowmarkProcess({
      command: "flowmark-lint",
      argv: ["--tex-vocabulary", "--format", "json", "--context", contextPath],
      env: context.env,
      timeoutMs: context.flowmarkLintTimeoutMs,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  if (!outcome.ok) {
    throw new Error(`Flowmark gave no TeX vocabulary: ${outcome.message}`);
  }
  const answer: unknown = JSON.parse(outcome.stdout);
  if (!vocabularyAnswer(answer)) {
    throw new Error(`Flowmark gave a TeX vocabulary of an unknown form: ${outcome.stdout}`);
  }
  const index: unknown = JSON.parse(await readFile(answer.index, "utf8"));
  if (!texstudioIndex(index)) {
    throw new Error(`The TeXstudio command index ${answer.index} is not of schema 1`);
  }
  return { index, packages: answer.packages };
}
