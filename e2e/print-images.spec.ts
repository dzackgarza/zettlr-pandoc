/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Print window image E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Opens the print window of the assembled app on a document
 *                  with a remote image, a data URL image and a local image,
 *                  and reads what each image element loaded.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  preserveArtifacts,
  shutdown,
} from "./support/electron-app";

// One transparent pixel.
const PIXEL_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const DATA_URL = `data:image/png;base64,${PIXEL_BASE64}`;

interface PrintedImage {
  alt: string;
  src: string | null;
  naturalWidth: number;
}

async function findPrintPage(browser: Browser, timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().includes("/print/"));
    if (page !== undefined) {
      return page;
    }
    await delay(100);
  }
  throw new Error("The print window did not open");
}

describe("print window images", function () {
  it("loads a remote image, a data URL image and a local image", async function () {
    const artifactDirectory = path.join(tmpdir(), "zettlr-print-images-e2e-latest");
    const pixel = Buffer.from(PIXEL_BASE64, "base64");
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(pixel);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const remoteUrl = `http://127.0.0.1:${port}/remote.png`;

    const fixture = await createFixture("zettlr-print-images-e2e-", {
      documentName: "figures.md",
      documentContents: [
        "# Figures",
        "",
        `![remote](${remoteUrl})`,
        "",
        `![data](${DATA_URL})`,
        "",
        "![local](assets/../local.png)",
        "",
      ].join("\n"),
    });
    const workspace = path.dirname(fixture.documentPath);
    await writeFile(path.join(workspace, "local.png"), pixel);

    const rendererEvents: string[] = [];
    const screenshots = new Map<string, Buffer>();
    const app = await attach(fixture.configDirectory, rendererEvents);
    try {
      const page = await findEditorPage(app.browser, this.timeout());
      await page.evaluate(async (documentPath) => {
        await window.ipc.invoke("application", { command: "print", payload: documentPath });
      }, fixture.documentPath);

      const printPage = await findPrintPage(app.browser, 20_000);
      await printPage.waitForFunction(
        () => {
          const images = Array.from(document.querySelectorAll("#print-container img"));
          return (
            images.length === 3 &&
            images.every((image) => image instanceof HTMLImageElement && image.complete)
          );
        },
        undefined,
        { timeout: 20_000 },
      );
      screenshots.set("print-window.png", await printPage.screenshot());
      const images: PrintedImage[] = await printPage.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLImageElement>("#print-container img")).map(
          (image) => ({
            alt: image.alt,
            src: image.getAttribute("src"),
            naturalWidth: image.naturalWidth,
          }),
        ),
      );
      await printPage.close();

      assert.deepEqual(images, [
        { alt: "remote", src: remoteUrl, naturalWidth: 1 },
        { alt: "data", src: DATA_URL, naturalWidth: 1 },
        { alt: "local", src: `safe-file://${workspace}/local.png`, naturalWidth: 1 },
      ]);
    } finally {
      await shutdown(app.browser, app.appProcess);
      await new Promise((resolve) => server.close(resolve));
      await preserveArtifacts(
        artifactDirectory,
        fixture.root,
        app.getOutput(),
        rendererEvents,
        screenshots,
      );
      await rm(fixture.root, { recursive: true, force: true });
      assertCleanExit(app.getOutput());
    }
  });
});
