import { cp } from "node:fs/promises";
import path from "node:path";
import { openScene } from "./visual/scene.mjs";

const outputDirectory = process.argv[2];
if (typeof outputDirectory !== "string" || outputDirectory === "") {
  throw new Error("usage: node test/tikz-editor-fullscreen-capture.mjs <outputDirectory>");
}

await cp(
  path.join(process.cwd(), "vendor/tikz-editor/src"),
  path.join(outputDirectory, "tikz-editor"),
  { recursive: true },
);

const scene = await openScene({
  width: 1200,
  height: 800,
  args: ["--ozone-platform=x11", "--disable-gpu"],
});
try {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body,#preview{margin:0;width:100%;height:100%;overflow:hidden}
    #editor{display:none}
  </style></head><body><div id="editor"></div><div id="preview"></div><script src="./tikz-editor-fullscreen-bundle.js"></script></body></html>`;
  await scene.open("tikz-editor-fullscreen.html", html);
  await scene.page.evaluate(() => window.tikzEditorFullscreenReady);

  const visualButton = scene.page.getByRole("button", { name: "Visual" });
  await visualButton.click();
  const frame = scene.page.frameLocator(".tikz-editor-frame");
  await frame.locator("body").waitFor();

  const expand = scene.page.locator(".tikz-live-preview-expand");
  await expand.click();
  await scene.page.waitForFunction(
    () => document.querySelector(".tikz-live-preview")?.classList.contains("fullscreen") === true,
  );
  const exit = frame.getByRole("button", { name: "Exit fullscreen" });
  await exit.waitFor();
  await exit.click();
  await scene.page.waitForFunction(
    () => document.querySelector(".tikz-live-preview")?.classList.contains("fullscreen") !== true,
  );

  await expand.click();
  await scene.page.waitForFunction(
    () => document.querySelector(".tikz-live-preview")?.classList.contains("fullscreen") === true,
  );
  await frame.locator("body").press("Escape");
  await scene.page.waitForFunction(
    () => document.querySelector(".tikz-live-preview")?.classList.contains("fullscreen") !== true,
  );

  console.log(JSON.stringify({ buttonExit: true, escapeExit: true }));
} finally {
  await scene.close();
}
