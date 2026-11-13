/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Tests of the shell command runner
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     An export command of the author is shell text. The
 *                  application gives it the file or the Project folder of
 *                  the export as an argument. These tests run a real command
 *                  that prints the arguments it got.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { runShellCommand } from "source/app/service-providers/commands/exporter/run-shell-command";

/** A command that prints each of its arguments, each ended by NUL. */
const PRINT_ARGUMENTS = `sh -c 'printf "%s\\0" "$@"' sh`;

/** Names that an author gives a file or a folder. */
const NAMES = [
  "/notes/Halphen's Pencils.md",
  '/notes/The "K3" case.md',
  '/notes/Halphen\'s "pencils".md',
  "/notes/It's here!.md",
  "/notes/Cost of $HOME (draft) & figures.md",
  "/notes/plain.md",
];

describe("runShellCommand", function () {
  for (const name of NAMES) {
    it(`gives the command ${name} as one argument`, async function () {
      const output = await runShellCommand(PRINT_ARGUMENTS, [name], tmpdir());

      assert.equal(output.code, 0, output.stderr);
      assert.deepEqual(output.stdout.split("\0").slice(0, -1), [name]);
    });
  }

  it("gives the command two arguments in their order", async function () {
    const output = await runShellCommand(
      PRINT_ARGUMENTS,
      ["/notes/Halphen's Pencils.md", "/out/Halphen's Pencils.pdf"],
      tmpdir(),
    );

    assert.equal(output.code, 0, output.stderr);
    assert.deepEqual(output.stdout.split("\0").slice(0, -1), [
      "/notes/Halphen's Pencils.md",
      "/out/Halphen's Pencils.pdf",
    ]);
  });
});
