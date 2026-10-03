// Drives the standalone TikZ workbench page served by
// packages/tikz-workbench/standalone/server.ts. It opens the visual editor
// compiles the file, edits the source pane,
// saves, and then saves again after the file changed on disk. It prints a JSON
// report and leaves one screenshot per state in the output directory.
//
// Usage: node test/tikz-standalone-drive.mjs <url> <file.tikz> <outputDirectory>

import { readFile, writeFile } from "node:fs/promises";
import { openScene } from "./visual/scene.mjs";

const [url, documentPath] = process.argv.slice(2);
if (url === undefined || documentPath === undefined) {
  throw new Error("usage: node test/tikz-standalone-drive.mjs <url> <file.tikz> <outputDirectory>");
}

const scene = await openScene({
  width: 1400,
  height: 900,
  args: ["--ozone-platform=x11", "--disable-gpu"],
});
// The page's own account of a failed step: console output, uncaught errors
// and failed requests, printed with the page text when a step throws.
const pageLog = [];
scene.page.on("console", (message) => pageLog.push(`console.${message.type()}: ${message.text()}`));
scene.page.on("pageerror", (error) => pageLog.push(`pageerror: ${error.stack}`));
scene.page.on("requestfailed", (request) =>
  pageLog.push(
    `requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText}`,
  ),
);
scene.page.on("response", (response) => {
  if (response.status() >= 400) pageLog.push(`response ${response.status()}: ${response.url()}`);
});
try {
  const { page } = scene;
  await page.goto(url);

  await page.waitForFunction(
    () => document.querySelector(".tikz-live-preview-status")?.textContent === "Synced",
    undefined,
    { timeout: 60_000 },
  );
  const editorFrame = page.frameLocator('iframe[title="TikZ visual editor"]');
  await editorFrame.getByTestId("app-menubar").waitFor();
  await editorFrame
    .getByText(/^Computing/u)
    .first()
    .waitFor({ state: "hidden", timeout: 60_000 });
  const visualStatus = await page.locator(".tikz-live-preview-status").textContent();
  await scene.capture("01-visual-editor");
  const sourcePaneVisibleInVisualMode = await page.locator(".tikz-source-editor").isVisible();
  await page.getByRole("button", { name: "TeX render" }).click();
  const figure = page.locator(".tikz-live-preview-figure");
  await figure.waitFor({ timeout: 60_000 });
  await page
    .locator(".tikz-live-preview-figure .viewer-canvas img")
    .waitFor({ state: "visible", timeout: 60_000 });
  const figureSource = await page.locator(".tikz-figure-viewer-source").getAttribute("src");
  const figureSvg = decodeURIComponent(figureSource.slice(figureSource.indexOf(",") + 1));
  await scene.capture("02-compiled-preview");

  const appended = "\n% saved from the standalone workbench";
  await page.locator(".tikz-source-editor .cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(appended);
  const dirtyStatus = await page.locator(".tikz-standalone-status").textContent();
  await page.keyboard.press("Control+s");
  await page.waitForFunction(
    () => document.querySelector(".tikz-standalone-status")?.textContent === "Saved",
  );
  const savedFile = await readFile(documentPath, "utf8");
  await scene.capture("03-saved");

  const externalEdit = `${savedFile}\n% changed on disk by another program`;
  await writeFile(documentPath, externalEdit, "utf8");
  await page.keyboard.type("\n% stale edit");
  await page.keyboard.press("Control+s");
  await page.waitForFunction(() =>
    document
      .querySelector(".tikz-standalone-status")
      ?.textContent?.includes("412 Precondition Failed"),
  );
  const fileAfterStaleSave = await readFile(documentPath, "utf8");
  await page.locator(".file-menu summary").click();
  const staleSaveButtonEnabled = await page
    .getByRole("button", { name: "Save", exact: true })
    .isEnabled();
  await scene.capture("04-stale-save-refused");

  console.log(
    JSON.stringify({
      figureSvg,
      visualStatus,
      sourcePaneVisibleInVisualMode,
      dirtyStatus,
      savedFile,
      externalEdit,
      fileAfterStaleSave,
      staleSaveButtonEnabled,
    }),
  );
} catch (error) {
  const pageText = await scene.page.evaluate(() => document.body.innerText);
  console.error(`page text:\n${pageText}\npage log:\n${pageLog.join("\n")}`);
  throw error;
} finally {
  await scene.page.close({ runBeforeUnload: false });
  await scene.close();
}
