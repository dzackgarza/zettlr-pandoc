/**
 * The spec reporter of mocha with the wall time of each spec file (#70).
 *
 * An e2e run starts the app for each file, and the time of a run is the sum
 * of its files. The reporter prints the time of a file when its last suite
 * ends, and after the summary of mocha a table of each file by time, the
 * slowest first, with its failures. A mocha reporter is a class that takes
 * the runner (https://mochajs.org/api/tutorial-custom-reporter).
 */

import path from "node:path";
import Mocha from "mocha";

const { EVENT_SUITE_BEGIN, EVENT_SUITE_END, EVENT_TEST_FAIL, EVENT_RUN_END } =
  Mocha.Runner.constants;

interface FileTime {
  file: string;
  startedAt: number;
  endedAt: number;
  failures: number;
  openSuites: number;
}

export default class TimedSpecReporter extends Mocha.reporters.Spec {
  constructor(runner: Mocha.Runner, options: Mocha.MochaOptions) {
    super(runner, options);
    const files = new Map<string, FileTime>();
    const fileOf = (suite: Mocha.Suite): string | undefined =>
      suite.file === undefined ? undefined : path.relative(process.cwd(), suite.file);

    runner.on(EVENT_SUITE_BEGIN, (suite: Mocha.Suite) => {
      const file = fileOf(suite);
      if (file === undefined || suite.parent?.root !== true) {
        return;
      }
      const known = files.get(file);
      if (known === undefined) {
        const now = Date.now();
        files.set(file, { file, startedAt: now, endedAt: now, failures: 0, openSuites: 1 });
        return;
      }
      known.openSuites += 1;
    });

    runner.on(EVENT_SUITE_END, (suite: Mocha.Suite) => {
      const file = fileOf(suite);
      const known = file === undefined ? undefined : files.get(file);
      if (known === undefined || suite.parent?.root !== true) {
        return;
      }
      known.openSuites -= 1;
      known.endedAt = Date.now();
      if (known.openSuites === 0) {
        console.log(`  ${known.file}: ${seconds(known)} s\n`);
      }
    });

    runner.on(EVENT_TEST_FAIL, (test: Mocha.Runnable) => {
      const file = test.file === undefined ? undefined : path.relative(process.cwd(), test.file);
      const known = file === undefined ? undefined : files.get(file);
      if (known !== undefined) {
        known.failures += 1;
      }
    });

    runner.once(EVENT_RUN_END, () => {
      const rows = [...files.values()].sort(
        (a, b) => b.endedAt - b.startedAt - (a.endedAt - a.startedAt),
      );
      const width = Math.max(4, ...rows.map((row) => row.file.length));
      console.log(`  ${"File".padEnd(width)}  Seconds  Failures`);
      for (const row of rows) {
        console.log(
          `  ${row.file.padEnd(width)}  ${seconds(row).padStart(7)}  ${String(row.failures).padStart(8)}`,
        );
      }
      console.log();
    });
  }
}

function seconds(time: FileTime): string {
  return ((time.endedAt - time.startedAt) / 1000).toFixed(1);
}
