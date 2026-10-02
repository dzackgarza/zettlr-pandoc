/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Flowmark format service
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Formats Markdown with the installed `flowmark` command.
 *                  The formatter and standalone linter share
 *                  flowmark-runtime.ts, so Zettlr has one Flowmark execution
 *                  boundary.
 *
 * END HEADER
 */

import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { type FlowmarkProcessFailureKind, runFlowmarkProcess } from "./flowmark-runtime";

export type FlowmarkResult =
  | { ok: true; formatted: string }
  | { ok: false; kind: FlowmarkProcessFailureKind; message: string };

export interface InPlaceFormatterOptions {
  /** The formatter executable. */
  command: string;
  /** Complete argv prefix placed before the temp-file path. */
  argsPrefix: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}

/**
 * Formats Markdown `text` with the installed `flowmark` command and returns
 * the rewritten bytes.
 *
 * @param   {number}  timeoutMs  `editor.formatTimeoutMs` from the app config
 */
export async function formatMarkdownText(
  text: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<FlowmarkResult> {
  return await runInPlaceFormatter(text, {
    command: "flowmark",
    argsPrefix: ["--inplace", "--nobackup", "--semantic", "--no-respect-gitignore"],
    env,
    timeoutMs,
  });
}

/**
 * Runs a formatter that rewrites its last argument in place over `text` and
 * returns the rewritten bytes. This service owns the temporary file.
 */
export async function runInPlaceFormatter(
  text: string,
  opts: InPlaceFormatterOptions,
): Promise<FlowmarkResult> {
  const dir = await mkdtemp(path.join(tmpdir(), "zettlr-flowmark-"));
  const file = path.join(dir, "document.md");

  try {
    await writeFile(file, text, "utf-8");
    const outcome = await runFlowmarkProcess({
      command: opts.command,
      argv: [...opts.argsPrefix, file],
      env: opts.env,
      timeoutMs: opts.timeoutMs,
    });
    if (!outcome.ok) {
      return { ok: false, kind: outcome.kind, message: outcome.message };
    }
    return { ok: true, formatted: await readFile(file, "utf-8") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
