/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        A recipe runner that records its runs
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A PDF export starts `just` with a literal argument vector.
 *                  A spec of that export puts this `just` first on the PATH
 *                  of its process. It is a real executable: it records its
 *                  working directory and each argument as the process got
 *                  them, and leaves the file that the recipe leaves,
 *                  "<title>-<date>.pdf". No application code is replaced.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** One run of the recipe runner. */
export interface RecipeRun {
  /** The working directory of the run. */
  cwd: string;
  /** The arguments of the run. */
  argv: string[];
}

export interface RecordingJust {
  /** Each run since the last `forget`, in the order of the runs. */
  runs: () => Promise<RecipeRun[]>;
  /** The run of an export that started the runner one time. */
  onlyRun: () => Promise<RecipeRun>;
  /** Drops the recorded runs. */
  forget: () => Promise<void>;
  /** Gives the process its PATH back and removes the runner. */
  remove: () => Promise<void>;
}

/**
 * The runner. Each run adds one record: the working directory and the
 * arguments, each ended by NUL, then one RS. The title is the fourth argument
 * of `compile-pandoc-project` and the fifth of `compile-pandoc`.
 */
const RUNNER = [
  "#!/bin/sh",
  `{ printf '%s\\0' "$PWD" "$@"; printf '\\036'; } >> "$(dirname "$0")/record.bin"`,
  'case "$3" in',
  '  compile-pandoc-project) title="$4" ;;',
  '  *) title="$5" ;;',
  "esac",
  ': > "$PWD/$title-01-01-26.pdf"',
  "",
].join("\n");

/** Puts the recording `just` first on the PATH of this process. */
export async function installRecordingJust(): Promise<RecordingJust> {
  const pathOfTheRun = process.env.PATH;
  if (pathOfTheRun === undefined) {
    throw new Error("The process of the spec has no PATH");
  }

  const directory = await mkdtemp(path.join(tmpdir(), "zettlr-recording-just-"));
  const recordFile = path.join(directory, "record.bin");
  const runner = path.join(directory, "just");
  await writeFile(runner, RUNNER);
  await chmod(runner, 0o755);
  await writeFile(recordFile, "");
  process.env.PATH = `${directory}${path.delimiter}${pathOfTheRun}`;

  async function runs(): Promise<RecipeRun[]> {
    const records = (await readFile(recordFile, "utf8")).split("\x1e");
    assert.equal(records[records.length - 1], "", "each record ends with RS");
    return records.slice(0, -1).map((record) => {
      const tokens = record.split("\0");
      assert.equal(tokens[tokens.length - 1], "", "each token ends with NUL");
      const [cwd, ...argv] = tokens.slice(0, -1);
      return { cwd, argv };
    });
  }

  return {
    runs,
    onlyRun: async () => {
      const recorded = await runs();
      assert.equal(recorded.length, 1, "one export starts the recipe runner one time");
      return recorded[0];
    },
    forget: async () => {
      await writeFile(recordFile, "");
    },
    remove: async () => {
      process.env.PATH = pathOfTheRun;
      await rm(directory, { recursive: true });
    },
  };
}
