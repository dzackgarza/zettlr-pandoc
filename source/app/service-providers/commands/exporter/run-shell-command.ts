import { spawn } from "child_process";

/** Collects a spawned process's streams and exit code. */
async function collectProcess(
  proc: ReturnType<typeof spawn>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let finalCode = 0;

  await new Promise<void>((resolve, reject) => {
    proc.stdout?.on("data", (data) => {
      stdout.push(String(data));
    });

    proc.stderr?.on("data", (data) => {
      stderr.push(String(data));
    });

    proc.on("close", (code: number, _signal) => {
      finalCode = code;
      resolve();
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });

  return {
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    code: finalCode,
  };
}

/**
 * Runs a command of the author in the shell. The command is shell text: the
 * shell reads its words, its variables and its operators. An argument is a
 * value: the shell gets each one as a positional parameter and the command
 * ends with "$@", so no argument is read as shell text and no caller quotes
 * one. A name with a quote, a space or a "$" arrives as one argument.
 *
 * @param   {string}    command  The shell text of the command
 * @param   {string[]}  argv     The arguments, which go after the command
 * @param   {string}    cwd      The working directory for the command
 *
 * @return  {object}             Returns an object with keys stdout, stderr, and code
 */
export async function runShellCommand(
  command: string,
  argv: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return await collectProcess(spawn("sh", ["-c", `${command} "$@"`, "sh", ...argv], { cwd }));
}

/**
 * Runs a command as a real process with a LITERAL argv array (shell: false;
 * review B2). Every element of argv arrives at the process exactly as given —
 * no shell tokenization, so quotes, spaces, and metacharacters in titles or
 * filenames never split or mangle arguments and no quoting layer is needed.
 * The command itself is still PATH-resolved by spawn.
 *
 * @param   {string}    command  The command to run (PATH-resolved).
 * @param   {string[]}  argv     The literal argument vector
 * @param   {string}    cwd      The working directory for the command
 * @param   {object}    env      The environment of the command
 *
 * @return  {object}             Returns an object with keys stdout, stderr, and code
 */
export async function runProcess(
  command: string,
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return await collectProcess(spawn(command, argv, { shell: false, cwd, env }));
}
