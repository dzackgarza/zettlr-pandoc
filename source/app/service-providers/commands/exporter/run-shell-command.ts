import { spawn } from 'child_process'

/** Collects a spawned process's streams and exit code. */
async function collectProcess (proc: ReturnType<typeof spawn>): Promise<{ stdout: string, stderr: string, code: number }> {
  const stdout: string[] = []
  const stderr: string[] = []
  let finalCode = 0

  await new Promise<void>((resolve, reject) => {
    proc.stdout?.on('data', (data) => {
      stdout.push(String(data))
    })

    proc.stderr?.on('data', (data) => {
      stderr.push(String(data))
    })

    proc.on('close', (code: number, _signal) => {
      finalCode = code
      resolve()
    })

    proc.on('error', (err) => {
      reject(err)
    })
  })

  return {
    stdout: stdout.join(''),
    stderr: stderr.join(''),
    code: finalCode
  }
}

/**
 * Runs an arbitrary command in the shell, passing any arguments and a working
 * directory. NOTE: THIS IS AN UNSAFE FUNCTION. DO NOT PASS UNSANITIZED INPUT TO
 * IT TO PREVENT ANY ATTACKS!
 *
 * @param   {string}    command  The command to run.
 * @param   {string[]}  argv     Any arguments to pass to the command
 * @param   {string}    cwd      The working directory for the command
 *
 * @return  {object}             Returns an object with keys stdout, stderr, and code
 */
export async function runShellCommand (command: string, argv: string[], cwd: string): Promise<{ stdout: string, stderr: string, code: number }> {
  // NOTE the shell: true parameter, which helps some commands find files.
  return await collectProcess(spawn(command, argv, { shell: true, cwd }))
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
 *
 * @return  {object}             Returns an object with keys stdout, stderr, and code
 */
export async function runProcess (command: string, argv: string[], cwd: string): Promise<{ stdout: string, stderr: string, code: number }> {
  return await collectProcess(spawn(command, argv, { shell: false, cwd }))
}
