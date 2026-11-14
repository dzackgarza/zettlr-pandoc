/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        X displays of an E2E run
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     An E2E run owns its X displays, as it owns its loopback
 *                  and its session bus. An X server of the run binds its
 *                  socket in /tmp/.X11-unix, and Xvfb removes a socket that
 *                  is at its path before it binds: with -displayfd it takes
 *                  display 0 over the lock of a running server, and its exit
 *                  removes the path. The X server of the desktop of the
 *                  author then has no socket path, and no new X11 client
 *                  connects to it. The spec holds an X socket path of the
 *                  host and starts an X server of the run on the display of
 *                  that path.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import path from "node:path";

const REPOSITORY = path.resolve(__dirname, "..");
const SOCKET_DIRECTORY = "/tmp/.X11-unix";

// Starts Xvfb on the display of its last argument, waits until the server
// accepts connections (it writes the number to descriptor 3), and stops it.
const XVFB_SOURCE = [
  'const { spawn } = require("node:child_process");',
  "const display = process.argv.at(-1);",
  'const server = spawn("Xvfb", [`:${display}`, "-displayfd", "3", "-nolisten", "tcp"],',
  '  { stdio: ["ignore", "ignore", "inherit", "pipe"] });',
  'server.stdio[3].once("data", () => server.kill("SIGTERM"));',
  'server.once("exit", (code, signal) => process.exit(code === 0 || signal === "SIGTERM" ? 0 : 1));',
].join("\n");

/** A display number whose socket path and lock file the host does not have. */
function freeDisplay(): number {
  for (;;) {
    const display = 3000 + Math.floor(Math.random() * 50_000);
    if (
      !existsSync(path.join(SOCKET_DIRECTORY, `X${display}`)) &&
      !existsSync(`/tmp/.X${display}-lock`)
    ) {
      return display;
    }
  }
}

/** Answers whether a connection to the path is accepted, or the error code. */
async function connectOutcome(socketPath: string): Promise<string> {
  const client = connect(socketPath);
  const outcome = await new Promise<string>((resolve) => {
    client.once("connect", () => resolve("accepted"));
    client.once("error", (error: NodeJS.ErrnoException) => resolve(String(error.code)));
  });
  client.destroy();
  return outcome;
}

describe("E2E run X displays", function () {
  let holder: Server | undefined;

  afterEach(async function () {
    if (holder !== undefined) {
      holder.close();
      await once(holder, "close");
      holder = undefined;
    }
  });

  it("leaves the X socket path of a server outside the run", async function () {
    const display = freeDisplay();
    const socketPath = path.join(SOCKET_DIRECTORY, `X${display}`);
    holder = createServer();
    holder.listen(socketPath);
    await once(holder, "listening");

    const run = spawnSync(
      "just",
      ["_e2e-run", process.execPath, "-e", XVFB_SOURCE, String(display)],
      { cwd: REPOSITORY, encoding: "utf8" },
    );
    assert.equal(run.status, 0, `an X server of the run starts on :${display}: ${run.stderr}`);

    assert.equal(
      await connectOutcome(socketPath),
      "accepted",
      `the socket path of the host server accepts connections after the run: ${socketPath}`,
    );
  });
});
