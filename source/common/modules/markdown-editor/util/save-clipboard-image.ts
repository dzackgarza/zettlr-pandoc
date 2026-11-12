/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        saveClipboardImage, normalizePathForInsertion
 * CVM-Role:        Utility Functions
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     The one path from an image of the clipboard to an image
 *                  link in the editor: a paste event of the editor and the
 *                  command "Paste" of its context menu save the image through
 *                  the command save-image-from-clipboard.
 *
 * END HEADER
 */

import { pathBasename, relativePath } from "@common/util/renderer-path-polyfill";
import { type SaveImageFromClipboardAPI } from "source/app/service-providers/commands/save-image-from-clipboard";

const ipcRenderer = window.ipc;

/**
 * This function normalizes an absolute path in a way that is suitable for the
 * main editor, i.e., it should be easily readable for humans and as short as
 * possible.
 *
 * @param   {string}  p         The path to be normalized
 * @param   {string}  basePath  The base path for turning `p` relative.
 *
 * @return  {string}            The normalized path.
 */
export function normalizePathForInsertion(p: string, basePath: string): string {
  const relative = relativePath(basePath, p);
  let sanitizedPath = relative.replace(/\\/g, "/");
  if (!sanitizedPath.startsWith("./") && !sanitizedPath.startsWith("../")) {
    sanitizedPath = "./" + sanitizedPath;
  }
  return sanitizedPath;
}

/** Reads an image as a data URL. */
function readAsDataUrl(image: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("abort", () => reject(new Error("Image read was aborted")));
    reader.addEventListener("error", () => reject(new Error("Could not read image data")));
    reader.addEventListener("load", () => {
      if (typeof reader.result !== "string") {
        reject(new Error("The image was not read as a data URL"));
        return;
      }
      resolve(reader.result);
    });
    reader.readAsDataURL(image);
  });
}

/**
 * Asks the author where to save an image of the clipboard, saves it, and
 * gives the image link for the editor.
 *
 * @param   {string}            basePath   The folder of the document
 * @param   {Blob}              image      The image of the clipboard
 * @param   {string|undefined}  imageName  The file name that the clipboard gives
 *
 * @return  {Promise<string|undefined>}    The image link, or undefined when the
 *                                         author cancelled
 */
export async function saveClipboardImage(
  basePath: string,
  image: Blob,
  imageName: string | undefined,
): Promise<string | undefined> {
  const payload: SaveImageFromClipboardAPI = {
    basePath,
    imageData: await readAsDataUrl(image),
    imageName,
  };
  const savedPath: string | undefined = await ipcRenderer.invoke("application", {
    command: "save-image-from-clipboard",
    payload,
  });
  if (savedPath === undefined) {
    return undefined;
  }
  const p = normalizePathForInsertion(savedPath, basePath);
  return `![${pathBasename(p)}](${p})`;
}
