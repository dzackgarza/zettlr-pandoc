/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Tests of the failures of the update provider
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The update provider reads a release list, downloads an
 *                  asset of a release, and checks it against the SHA256 sums
 *                  of the release. A failure of each step gives the update
 *                  window a state that names it, and leaves no download in
 *                  the downloads folder that the provider gave up (#210).
 *                  The real provider reads a release server on loopback
 *                  through its real HTTP calls, and a spec drives it through
 *                  the IPC handler of the update window.
 *
 * END HEADER
 */

import "./headless-electron-harness.cjs";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import ConfigProvider from "source/app/service-providers/config";
import LogProvider from "source/app/service-providers/log";
import UpdateProvider, { type UpdateState } from "source/app/service-providers/updates";
import { downloads, ipcMainHandlers, net, notifications } from "./headless-electron-harness.cjs";
import { unexpectedStoreWriteFailure } from "./store-write-failure";

const ASSET_NAME = "Zettlr-Pandoc-9.0.0-x86_64.AppImage";
const ASSET = Buffer.alloc(256 * 1024, 7);
const ASSET_SHA256 = createHash("sha256").update(ASSET).digest("hex");
const WRONG_SHA256 = createHash("sha256").update("another file").digest("hex");

/** What the release server answers. */
interface ReleaseServer {
  /** The SHA256 of the asset that SHA256SUMS.txt names. */
  sums: string;
  /** Whether the asset download stops after its first half. */
  stopsHalfway: boolean;
}

describe("The failures of the update provider (#210)", function () {
  this.timeout(30_000);

  const release: ReleaseServer = { sums: ASSET_SHA256, stopsHalfway: false };
  let server: Server;
  let origin: string;
  let provider: UpdateProvider;
  const log = new LogProvider();
  const config = new ConfigProvider(
    log,
    [path.resolve("static", "lang")],
    unexpectedStoreWriteFailure,
  );

  before(async function () {
    server = createServer((request, response) => {
      if (request.url?.startsWith("/repos/owner/app/releases") === true) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify([
            {
              id: 1,
              tag_name: "v9.0.0",
              name: "v9.0.0",
              prerelease: false,
              html_url: `${origin}/owner/app/releases/tag/v9.0.0`,
              body: "Changes of the release.",
              published_at: "2026-11-13T00:00:00Z",
              assets: [
                {
                  name: ASSET_NAME,
                  size: ASSET.length,
                  browser_download_url: `${origin}/download/${ASSET_NAME}`,
                },
                {
                  name: "SHA256SUMS.txt",
                  size: 100,
                  browser_download_url: `${origin}/download/SHA256SUMS.txt`,
                },
              ],
            },
          ]),
        );
      } else if (request.url === "/download/SHA256SUMS.txt") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(`${release.sums}  ${ASSET_NAME}\n`);
      } else if (request.url === `/download/${ASSET_NAME}`) {
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(ASSET.length),
        });
        if (release.stopsHalfway) {
          response.write(ASSET.subarray(0, ASSET.length / 2));
        } else {
          response.end(ASSET);
        }
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(async function () {
    release.sums = ASSET_SHA256;
    release.stopsHalfway = false;
    net.online = true;
    notifications.shown.length = 0;
    await rm(path.join(downloads, ASSET_NAME), { force: true });
    provider = new UpdateProvider(
      log,
      config,
      { showUpdateWindow: () => undefined },
      {
        releasePage: `${origin}/owner/app/releases`,
        releasesApi: `${origin}/repos/owner/app/releases`,
      },
    );
  });

  after(async function () {
    net.online = true;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(path.join(downloads, ASSET_NAME), { force: true });
  });

  /** Sends a command of the update window to the provider. */
  async function send(command: string, payload?: string): Promise<void> {
    const handler = ipcMainHandlers.get("update-provider");
    assert.ok(handler !== undefined, "the provider registers no update-provider handler");
    await handler({}, { command, payload });
  }

  /** The state of the provider once `holds` is true of it, within five seconds. */
  async function stateWhen(
    what: string,
    holds: (state: UpdateState) => boolean,
  ): Promise<UpdateState> {
    const deadline = Date.now() + 5000;
    while (!holds(provider.getUpdateState())) {
      assert.ok(
        Date.now() < deadline,
        `${what}: the state is ${JSON.stringify(provider.getUpdateState())}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return provider.getUpdateState();
  }

  /** Whether the downloads folder holds the asset. */
  async function downloadIsOnDisk(): Promise<boolean> {
    return (await readdir(downloads)).includes(ASSET_NAME);
  }

  /** Checks for the release and starts the download of its asset. */
  async function startDownload(): Promise<void> {
    await send("check-for-update");
    assert.equal(provider.getUpdateState().updateAvailable, true);
    await send("request-app-update", `${origin}/download/${ASSET_NAME}`);
  }

  /** Downloads the asset of the release to its end. */
  async function downloadAsset(): Promise<void> {
    await startDownload();
    const deadline = Date.now() + 5000;
    while (!notifications.shown.some((shown) => shown.body.startsWith("Download of"))) {
      assert.ok(Date.now() < deadline, "the download does not end");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it("says that a check without a network connection did not run", async function () {
    await send("check-for-update");
    assert.equal(provider.getUpdateState().lastErrorCode, undefined);
    net.online = false;
    await send("check-for-update");
    assert.equal(provider.getUpdateState().lastErrorCode, "EOFFLINE");
  });

  it("removes a download whose checksum is not the one of the release", async function () {
    release.sums = WRONG_SHA256;
    await downloadAsset();
    await send("begin-update");
    const state = await stateWhen("the verify fails", (s) => s.lastErrorCode !== undefined);
    assert.equal(state.lastErrorCode, "EVERIFY");
    assert.equal(
      notifications.shown.at(-1)?.body,
      state.lastErrorMessage,
      "the notification does not give the failure of the verify",
    );
    assert.equal(await downloadIsOnDisk(), false, "the download that failed its check stays");
  });

  it("names a download that is gone when the update starts", async function () {
    await downloadAsset();
    await rm(path.join(downloads, ASSET_NAME));
    await send("begin-update");
    const state = await stateWhen("the start fails", (s) => s.lastErrorCode !== undefined);
    assert.equal(state.lastErrorCode, "EREADFILE");
  });

  it("removes a partial download at quit", async function () {
    release.stopsHalfway = true;
    await startDownload();
    await stateWhen("half of the asset arrives", (state) => state.size_downloaded > 0);
    assert.equal(await downloadIsOnDisk(), true);
    await provider.shutdown();
    assert.equal(await downloadIsOnDisk(), false, "the partial download stays");
  });
});
