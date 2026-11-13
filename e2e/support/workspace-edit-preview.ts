/**
 * The preview of a workspace edit in a window (#6): read its rows, answer it,
 * and wait for the text that the answer gives a file.
 */

import { readFile } from "node:fs/promises";
import { type Page } from "playwright";
import { delay } from "./electron-app";

export const PREVIEW = ".workspace-edit-preview";

/** One document of the preview, with each changed run of lines. */
export interface PreviewRow {
  documentPath: string;
  changes: Array<{ before: string; after: string }>;
}

/** The rows of the preview dialog, in the order in which it shows them. */
export async function previewRows(page: Page): Promise<PreviewRow[]> {
  return await page.locator(`${PREVIEW} [data-preview-path]`).evaluateAll((rows) =>
    rows.map((row) => ({
      documentPath: row.getAttribute("data-preview-path") ?? "",
      changes: [...row.querySelectorAll("[data-preview-change]")].map((change) => ({
        before: change.querySelector("[data-preview-before]")?.textContent ?? "",
        after: change.querySelector("[data-preview-after]")?.textContent ?? "",
      })),
    })),
  );
}

/**
 * Waits for the preview, clicks Apply or Cancel, and waits until the dialog
 * is gone. Answers the documents that the preview showed.
 */
export async function answerPreview(page: Page, answer: "apply" | "cancel"): Promise<string[]> {
  const preview = page.locator(PREVIEW);
  await preview.waitFor({ state: "visible", timeout: 30_000 });
  const documents = (await previewRows(page)).map((row) => row.documentPath);
  await preview.locator(answer === "apply" ? "[data-apply]" : "[data-cancel]").click();
  await preview.waitFor({ state: "detached", timeout: 30_000 });
  return documents;
}

/** The text of a file once it is `expected`, or its text after ten seconds. */
export async function textOnceItIs(file: string, expected: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  let text = await readFile(file, "utf8");
  while (Date.now() < deadline && text !== expected) {
    await delay(100);
    text = await readFile(file, "utf8");
  }
  return text;
}
