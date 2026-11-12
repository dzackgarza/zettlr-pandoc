/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Loopback of an E2E run (#215)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     An E2E run owns the loopback ports of its apps, as it owns
 *                  the display and the session bus. A desktop app of the
 *                  author holds the default Agent API port; the first start
 *                  of an app of the run binds that port too. The spec holds
 *                  a loopback port outside the run and starts a command in
 *                  the run environment of the justfile that binds the same
 *                  port.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:net";
import path from "node:path";

const REPOSITORY = path.resolve(__dirname, "..");

// Binds 127.0.0.1 at the port of its last argument and exits 0, or writes
// the error code and exits 1.
const BIND_SOURCE = [
  'const net = require("node:net");',
  "const port = Number(process.argv.at(-1));",
  "const server = net.createServer();",
  'server.once("error", (error) => { console.error(error.code); process.exit(1); });',
  'server.listen(port, "127.0.0.1", () => server.close(() => process.exit(0)));',
].join("\n");

describe("E2E run loopback (#215)", function () {
  let holder: Server | undefined;

  afterEach(async function () {
    if (holder !== undefined) {
      holder.close();
      await once(holder, "close");
      holder = undefined;
    }
  });

  it("binds a loopback port that a process outside the run holds", async function () {
    holder = createServer();
    holder.listen(0, "127.0.0.1");
    await once(holder, "listening");
    const address = holder.address();
    assert.ok(address !== null && typeof address === "object", "the holder has a port");

    const run = spawnSync(
      "just",
      ["_e2e-run", process.execPath, "-e", BIND_SOURCE, String(address.port)],
      { cwd: REPOSITORY, encoding: "utf8" },
    );

    assert.equal(
      run.status,
      0,
      `a command of the run binds 127.0.0.1:${address.port}: ${run.stdout}${run.stderr}`,
    );
  });
});
