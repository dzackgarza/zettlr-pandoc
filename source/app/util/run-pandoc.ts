/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        runPandoc
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Runs pandoc with one defaults file and gives its exit
 *                  code and its output.
 *
 * END HEADER
 */

import { spawn } from "child_process";

export interface PandocRunnerOutput {
  code: number;
  stdout: string[];
  stderr: string[];
}

/** The lines of a stream that hold text. */
function textLines(chunks: string[]): string[] {
  return chunks
    .join("")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

/**
 * Runs `pandoc --defaults <defaultsFile>`. The promise rejects when the
 * process does not start. An exit code other than 0 is a result: the caller
 * reads `code` and `stderr`.
 *
 * @param   {string}  defaultsFile  The defaults file, already on disk
 * @param   {string}  cwd           The working directory of the process
 * @param   env                     The environment of the process
 */
export async function runPandoc(
  defaultsFile: string,
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<PandocRunnerOutput> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const code = await new Promise<number>((resolve, reject) => {
    const pandocProcess = spawn("pandoc", ["--defaults", defaultsFile], { cwd, env });

    pandocProcess.stdout.on("data", (data) => {
      stdout.push(String(data));
    });

    pandocProcess.stderr.on("data", (data) => {
      stderr.push(String(data));
    });

    pandocProcess.on("close", (exitCode: number, _signal) => {
      resolve(exitCode);
    });

    pandocProcess.on("error", (err) => {
      reject(err);
    });
  });

  return { code, stdout: textLines(stdout), stderr: textLines(stderr) };
}
