/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        runEachStep, throwFailures
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Steps that each must run, also after one of them failed.
 *                  The semantics are those of `Promise.allSettled` and of
 *                  `AggregateError` (ECMAScript 2020 and 2021), for steps
 *                  that must not run at the same time.
 *
 * END HEADER
 */

/**
 * Throws what failed: nothing for no failure, the error for one, and for
 * more an `AggregateError` whose message has the message of each on a line
 * of its own.
 */
export function throwFailures(failures: readonly Error[]): void {
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, failures.map((failure) => failure.message).join("\n"));
  }
}

/**
 * Runs the steps in order. A step that fails does not stop the steps after
 * it. When each step ran, the failures are thrown (`throwFailures`).
 */
export async function runEachStep(steps: ReadonlyArray<() => Promise<void>>): Promise<void> {
  const failures: Error[] = [];
  for (const step of steps) {
    await step().catch((failure: Error) => {
      failures.push(failure);
    });
  }
  throwFailures(failures);
}
