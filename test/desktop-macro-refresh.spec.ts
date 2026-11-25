import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const REPOSITORY = path.join(__dirname, "..");
const REFRESH = path.join(REPOSITORY, "scripts", "desktop", "zettlr-pandoc-refresh-macros");
const PROJECTION = path.join("templates", "css", "mathjax-macros.json");

describe("The desktop launcher refreshes the central MathJax projection", function () {
  this.timeout(240_000);

  let home: string;
  let pandocDirectory: string;
  let uvCache: string;

  before(async function () {
    home = await mkdtemp(path.join(tmpdir(), "zettlr-macro-refresh-"));
    pandocDirectory = path.join(home, ".pandoc");
    const workstationPandoc = await realpath(path.join(homedir(), ".pandoc"));
    await run("git", ["clone", "--quiet", "--local", workstationPandoc, pandocDirectory]);
    uvCache = (await run("uv", ["cache", "dir"])).stdout.trim();
  });

  after(async function () {
    await rm(home, { recursive: true, force: true });
  });

  it("writes the projection of the macro tree of ~/.pandoc before a start", async function () {
    const committed = (
      await run("git", ["-C", pandocDirectory, "show", `HEAD:${PROJECTION}`], {
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout;
    await rm(path.join(pandocDirectory, PROJECTION));

    const environment: NodeJS.ProcessEnv = { ...process.env, HOME: home, UV_CACHE_DIR: uvCache };
    delete environment.VIRTUAL_ENV;
    delete environment.PYTHONPATH;
    const refresh = await run(REFRESH, [], { cwd: home, env: environment }).catch(
      (error: Error & { stdout?: string; stderr?: string }) => {
        assert.fail(
          `The macro refresh of the launcher failed: ${error.message}\n${error.stderr ?? ""}`,
        );
      },
    );

    assert.equal(
      await readFile(path.join(pandocDirectory, PROJECTION), "utf8"),
      committed,
      `the refresh writes the projection that the generator of ~/.pandoc makes\n${refresh.stdout}`,
    );
  });
});
