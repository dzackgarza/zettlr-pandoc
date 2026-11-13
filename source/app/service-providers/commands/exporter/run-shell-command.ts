import { type ProcessExit, requireExit, runProcess } from "@dzack/external-process/run-process";

/**
 * Runs a command of the author in the shell. The command is shell text: the
 * shell reads its words, its variables and its operators. An argument is a
 * value: the shell gets each one as a positional parameter and the command
 * ends with "$@", so no argument is read as shell text and no caller quotes
 * one. A name with a quote, a space or a "$" arrives as one argument.
 *
 * The promise rejects when the shell does not start or a signal ends the
 * command, with the cause in the message.
 *
 * @param   {string}    command  The shell text of the command
 * @param   {string[]}  argv     The arguments, which go after the command
 * @param   {string}    cwd      The working directory for the command
 */
export async function runShellCommand(
  command: string,
  argv: string[],
  cwd: string,
): Promise<ProcessExit> {
  const outcome = await runProcess({
    command: "sh",
    args: ["-c", `${command} "$@"`, "sh", ...argv],
    env: process.env,
    cwd,
    timeLimitMs: "none",
    waitForGroup: false,
  });
  return requireExit(command, outcome);
}
