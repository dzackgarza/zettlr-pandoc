import { strict as assert } from "node:assert";
import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface StandaloneReport {
  figureSvg: string;
  visualStatus: string;
  dirtyStatus: string;
  savedFile: string;
  externalEdit: string;
  fileAfterStaleSave: string;
  staleSaveButtonEnabled: boolean;
}

// A wide figure: an arrow to (2,1) with a label, and a unit-diameter circle.
const SOURCE = [
  "\\begin{tikzpicture}",
  "\\draw[->] (0,0) -- (2,1) node[right] {$f$};",
  "\\draw (0,0) circle (0.5);",
  "\\end{tikzpicture}",
].join("\n");

async function serverUrl(server: ChildProcessWithoutNullStreams): Promise<string> {
  return await new Promise((resolve, reject) => {
    let output = "";
    server.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:\d+\//u.exec(output);
      if (match !== null) resolve(match[0]);
    });
    server.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    server.on("exit", (code) => {
      reject(new Error(`The standalone server exited with ${code}:\n${output}`));
    });
  });
}

describe("standalone TikZ workbench", function () {
  let directory: string;
  let documentPath: string;
  let server: ChildProcessWithoutNullStreams;
  let report: StandaloneReport;

  before(async function () {
    this.timeout(240000);
    directory = await mkdtemp(path.join(tmpdir(), "tikz-standalone-"));
    documentPath = path.join(directory, "figure.tikz");
    await writeFile(documentPath, SOURCE, "utf8");
    const root = process.cwd();
    server = spawn("bun", ["run", path.join(root, "packages/tikz-workbench/standalone/server.ts"), documentPath]);
    const url = await serverUrl(server);
    const { stdout } = await execFileAsync(
      "xvfb-run",
      ["-a", "node", path.join(root, "test/tikz-standalone-drive.mjs"), url, documentPath, directory],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    report = JSON.parse(stdout) as StandaloneReport;
  });

  after(async function () {
    server?.kill();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("previews the TeX compilation of the file", function () {
    const viewBox = /viewBox="([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)"/u.exec(report.figureSvg);
    assert.notEqual(viewBox, null, report.figureSvg.slice(0, 400));
    const [, , , width, height] = (viewBox as RegExpExecArray).map(Number);
    // The arrow reaches x = 2 and the circle spans y in [-0.5, 1]: a wide figure.
    assert.ok(width / height > 1.3, `figure is ${width} x ${height}`);
  });

  it("loads the file into the pinned visual editor", function () {
    assert.equal(report.visualStatus, "Synced");
  });

  it("saves source-pane edits to the file", function () {
    assert.equal(report.dirtyStatus, "Unsaved changes");
    assert.equal(report.savedFile, `${SOURCE}\n% saved from the standalone workbench`);
  });

  it("refuses to overwrite a file that changed on disk", function () {
    assert.equal(report.fileAfterStaleSave, report.externalEdit);
    assert.equal(report.staleSaveButtonEnabled, true);
  });
});
