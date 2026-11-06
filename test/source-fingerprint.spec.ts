/** The desktop launcher's source fingerprint over a real git repository. */

import { strict as assert } from "assert";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const script = path.resolve(
  __dirname,
  "../scripts/desktop/zettlr-pandoc-source-fingerprint",
);

function fingerprint(repo: string): string {
  return execFileSync(script, [repo], { encoding: "utf8" }).trim();
}

function repoWithUntracked(name: string, content: string): string {
  const repo = mkdtempSync(path.join(tmpdir(), "fingerprint-"));
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(path.join(repo, name), content);
  return repo;
}

describe("zettlr-pandoc-source-fingerprint", function () {
  it("hashes an untracked file whose name starts with a dash", function () {
    const first = fingerprint(repoWithUntracked("-.png", "one"));
    const second = fingerprint(repoWithUntracked("-.png", "two"));
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.notEqual(first, second);
  });
});
