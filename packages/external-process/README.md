# External process

Runs the external tools of the main process. Each run has the same time limit
rules, the same stop of its processes and the same causes of a failure. The
package imports nothing from the application and runs in Node only.

```ts
import { requireSuccess, runProcess } from "@dzack/external-process/run-process";
import { describeProbe, probeTool } from "@dzack/external-process/probe-tool";
```

| Module        | Content                                                                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-process` | `runProcess`: one run of a program and its outcome. `describeOutcome`, `requireExit` and `requireSuccess` turn an outcome into a cause or a value. |
| `probe-tool`  | `probeTool`: whether a tool answers `<tool> --version` on a PATH. `describeProbe` names why a tool was not found.                                    |

## A run

`runProcess` takes the program, its arguments, its environment, a working
folder, the text on standard input, a time limit (milliseconds, or `"none"`)
and `waitForGroup`. It does not start a shell: a caller that runs shell text
starts `sh -c` and gives each value as an argument.

- The program leads a process group of its own. A time limit that passes
  sends SIGTERM to the group and SIGKILL `KILL_GRACE_MS` later. A program
  that a signal ends leaves no process of its group. The exit of the process
  that called `runProcess` stops each run that has not ended.
- `waitForGroup: true`: the run ends when no process of its group is left,
  also a process that the program started and that closed its output (the
  TeX of a Pandoc filter). `false`: the run ends when the program and its
  output streams end, and a process that the program left running goes on.
- The answer is one of `exit` (with the exit code), `signal`, `timeout` and
  `not-started`. A program that does not start names its cause: `absent`,
  `not-executable`, `no-working-directory`, or `failed` with the errno. The
  promise rejects only for a fault of the function.

## A probe

`probeTool(tool, env)` runs `<tool> --version` with a limit of
`PROBE_TIME_LIMIT_MS`. A probe that found its tool is kept for the PATH and
the tool, so each caller gets the same answer and the tool starts one time;
concurrent callers share the run. A tool that was not found is probed again
at the next request. The exit code of `--version` does not count: a tool that
ends answered.

## Proof

`test/run-process.spec.ts`: the time limit stops the processes that the
program started, a run that waits for its group ends after the last of them,
the input and outputs of a run, a signal, the three causes of a failed start,
and the probe cache.
