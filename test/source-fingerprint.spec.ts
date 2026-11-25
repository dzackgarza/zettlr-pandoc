import { strict as assert } from "assert";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const script = path.resolve(__dirname, "../scripts/desktop/zettlr-pandoc-source-fingerprint");

function fingerprint(repo: string): string {
  return execFileSync(script, [repo], { encoding: "utf8" }).trim();
}

function repoWithUntracked(name: string, content: string): string {
  const repo = mkdtempSync(path.join(tmpdir(), "fingerprint-"));
  execFileSync("git", ["init", "-q", repo]);
  mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
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

  it("does not change for an edit of an agent document under docs", function () {
    const first = fingerprint(repoWithUntracked("docs/agents/export.md", "one"));
    const second = fingerprint(repoWithUntracked("docs/agents/export.md", "two"));
    assert.equal(first, second);
  });

  it("changes for an edit of a source file", function () {
    const first = fingerprint(repoWithUntracked("source/main.ts", "one"));
    const second = fingerprint(repoWithUntracked("source/main.ts", "two"));
    assert.notEqual(first, second);
  });
});
