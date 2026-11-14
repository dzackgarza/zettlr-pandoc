/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Process-wide error reporting boundary
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The only application-code boundary allowed to write an
 *                  error directly to stderr. Renderer callers are forwarded
 *                  to the main-process LogProvider over typed IPC; main-process
 *                  callers are bound directly to LogProvider by the service
 *                  container. If logging itself is unavailable or fails, the
 *                  independent stderr sink remains as the final diagnostic
 *                  surface and never recursively attempts to log itself.
 *                  A renderer has no stderr: a failed log request there is
 *                  a `RendererLogFailure` that rejects unhandled, and the
 *                  window writes it to its console, which the main process
 *                  records (`attachLogger`).
 *
 * END HEADER
 */

export type ErrorReporter = (message: string, details?: unknown) => void;

let installedReporter: ErrorReporter | undefined;

/** Bind this process's direct durable sink (the main process installs LogProvider). */
export function installErrorReporter(reporter: ErrorReporter): void {
  installedReporter = reporter;
}

function describeErrorValue(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeErrorArguments(args: readonly unknown[]): { message: string; details?: string } {
  const [first, ...rest] = args;
  if (typeof first === "string") {
    return {
      message: first,
      details: rest.length === 0 ? undefined : rest.map(describeErrorValue).join("\n"),
    };
  }

  const values = first === undefined ? rest : [first, ...rest];
  return {
    message: values.length === 0 ? "Unknown application error" : describeErrorValue(values[0]),
    details: values.length <= 1 ? undefined : values.slice(1).map(describeErrorValue).join("\n"),
  };
}

/** Final independent fallback of a Node process that bypasses the application logger itself. */
export function stderrError(...args: readonly unknown[]): void {
  process.stderr.write(`${args.map(describeErrorValue).join(" ")}\n`);
}

/**
 * A renderer could not send an error to the log. It rejects unhandled: the
 * window writes it to its console, and the capture of the window does not
 * send it to the log again (`registerRendererErrorCapture`).
 */
export class RendererLogFailure extends Error {
  constructor(message: string, details: string | undefined, cause: unknown) {
    const reported = details === undefined ? message : `${message}\n${details}`;
    super(`[Renderer logging failed] ${reported}\n${describeErrorValue(cause)}`, { cause });
    this.name = "RendererLogFailure";
  }
}

/**
 * Record an application error durably when the logging transport exists.
 * The function intentionally returns void so it can replace historical
 * direct console-error callbacks without changing control flow.
 */
export function reportError(...args: readonly unknown[]): void {
  const { message, details } = normalizeErrorArguments(args);

  if (installedReporter !== undefined) {
    try {
      installedReporter(message, details);
      return;
    } catch (loggingError) {
      stderrError(`[Error reporter failed] ${message}`, loggingError);
      return;
    }
  }

  if (
    typeof window !== "undefined" &&
    window.ipc !== undefined &&
    typeof window.ipc.invoke === "function"
  ) {
    void window.ipc
      .invoke("log-provider", {
        command: "record-error",
        payload: { message, details },
      })
      .catch((loggingError) => {
        throw new RendererLogFailure(message, details, loggingError);
      });
    return;
  }

  stderrError(message, details);
}
