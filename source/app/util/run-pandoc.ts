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

import { requireExit, runProcess } from "@dzack/external-process/run-process";

export interface PandocRunnerOutput {
  code: number;
  stdout: string[];
  stderr: string[];
}

/** The lines of a stream that hold text. */
function textLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}

/**
 * Runs `pandoc --defaults <defaultsFile>`. The promise rejects when the
 * process does not start or a signal ends it, with the cause in the message.
 * An exit code other than 0 is a result: the caller reads `code` and `stderr`.
 *
 * @param   {string}  defaultsFile  The defaults file, already on disk
 * @param   {string}  cwd           The working directory of the process
 * @param   env                     The environment of the process
 */
export async function runPandoc(
  defaultsFile: string,
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<PandocRunnerOutput> {
  const outcome = await runProcess({
    command: "pandoc",
    args: ["--defaults", defaultsFile],
    env,
    cwd,
    timeLimitMs: "none",
    waitForGroup: false,
  });
  const { code, stdout, stderr } = requireExit("pandoc", outcome);
  return { code, stdout: textLines(stdout), stderr: textLines(stderr) };
}
