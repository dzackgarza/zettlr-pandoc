// Drives the standalone TikZ workbench page served by
// packages/tikz-workbench/standalone/server.ts. It compiles the file, opens the
// visual editor, edits the source pane, saves, and then saves again after the
// file changed on disk. It prints a JSON report and leaves one screenshot per
// state in the output directory.
//
// Usage: node test/tikz-standalone-drive.mjs <url> <file.tikz> <outputDirectory>

import { readFile, writeFile } from "node:fs/promises";
import { openScene } from "./visual/scene.mjs";

const [url, documentPath] = process.argv.slice(2);
if (url === undefined || documentPath === undefined) {
  throw new Error("usage: node test/tikz-standalone-drive.mjs <url> <file.tikz> <outputDirectory>");
}

const scene = await openScene({ width: 1400, height: 900, args: ["--ozone-platform=x11", "--disable-gpu"] });
try {
  const { page } = scene;
  await page.goto(url);

  const figure = page.locator(".tikz-live-preview-figure");
  await figure.waitFor({ timeout: 60_000 });
  await page.locator(".tikz-live-preview-figure .viewer-canvas img").waitFor({ state: "visible", timeout: 60_000 });
  const figureSource = await page.locator(".tikz-figure-viewer-source").getAttribute("src");
  const figureSvg = decodeURIComponent(figureSource.slice(figureSource.indexOf(",") + 1));
  await scene.capture("01-compiled-preview");

  await page.getByRole("button", { name: "Visual editor" }).click();
  await page.waitForFunction(
    () => document.querySelector(".tikz-live-preview-status")?.textContent === "Synced",
    undefined,
    { timeout: 60_000 },
  );
  await page.frameLocator('iframe[title="TikZ visual editor"]').getByTestId("app-menubar").waitFor();
  const visualStatus = await page.locator(".tikz-live-preview-status").textContent();
  await scene.capture("02-visual-editor");

  const appended = "\n% saved from the standalone workbench";
  await page.locator(".tikz-source-editor .cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(appended);
  const dirtyStatus = await page.locator(".tikz-standalone-status").textContent();
  await page.keyboard.press("Control+s");
  await page.waitForFunction(() => document.querySelector(".tikz-standalone-status")?.textContent === "Saved");
  const savedFile = await readFile(documentPath, "utf8");
  await scene.capture("03-saved");

  const externalEdit = `${savedFile}\n% changed on disk by another program`;
  await writeFile(documentPath, externalEdit, "utf8");
  await page.keyboard.type("\n% stale edit");
  await page.keyboard.press("Control+s");
  await page.waitForFunction(() => {
    const status = document.querySelector(".tikz-standalone-status")?.textContent ?? "";
    return status !== "Unsaved changes" && status !== "Saved";
  });
  const fileAfterStaleSave = await readFile(documentPath, "utf8");
  const staleSaveButtonEnabled = await page.getByRole("button", { name: "Save" }).isEnabled();
  await scene.capture("04-stale-save-refused");

  console.log(
    JSON.stringify({
      figureSvg,
      visualStatus,
      dirtyStatus,
      savedFile,
      externalEdit,
      fileAfterStaleSave,
      staleSaveButtonEnabled,
    }),
  );
} finally {
  await scene.close();
}
