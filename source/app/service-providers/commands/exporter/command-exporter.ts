/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        runCommandExport
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Runs an export item whose engine is a command of the
 *                  author. The command gets one argument: the document, or
 *                  the folder of a Project. It decides what it writes, so
 *                  the export names no file.
 *
 * END HEADER
 */

import { runShellCommand } from "./run-shell-command";
import { splitLines } from "./split-lines";
import type { ExporterOptions, ExporterOutput } from "./types";

/**
 * @param   {ExporterOptions}  options  The options of the export
 * @param   {string}           command  The command of the item
 */
export async function runCommandExport(
  options: ExporterOptions,
  command: string,
): Promise<ExporterOutput> {
  const { argument, cwd } = options.commandSubject;
  const output = await runShellCommand(command, [argument], cwd);
  return {
    code: output.code,
    stdout: splitLines(output.stdout),
    stderr: splitLines(output.stderr),
    targetFile: null,
    texErrors: [],
  };
}
