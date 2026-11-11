// Run by test/unit-test-temp-directory.spec.ts in a Mocha process of its own.
// It makes a temporary directory the way the specs do, leaves it there, and
// writes its path to the file that ZETTLR_TEMP_PROBE_REPORT names.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

it("makes a temporary directory and leaves it", function () {
  const report = process.env.ZETTLR_TEMP_PROBE_REPORT;
  if (report === undefined) {
    throw new Error("ZETTLR_TEMP_PROBE_REPORT is not set");
  }
  const directory = mkdtempSync(path.join(tmpdir(), "zettlr-temp-probe-"));
  writeFileSync(path.join(directory, "content.txt"), "left by the probe");
  writeFileSync(report, directory);
});
