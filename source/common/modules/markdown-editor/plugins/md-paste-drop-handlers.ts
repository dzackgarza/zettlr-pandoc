/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Markdown Paste and Drop handlers
 * CVM-Role:        CodeMirror Extension
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file contains a few handlers that make the main editor
 *                  react properly to paste and drop events, such as converting
 *                  HTML to Markdown before insertion, or handling image drops.
 *
 * END HEADER
 */

import { type DOMEventHandlers } from "@codemirror/view";
import { reportError } from "@common/util/error-reporting";
import { hasImageExt, hasMdOrCodeExt } from "@common/util/file-extention-checks";
import html2md from "@common/util/html-to-md";
import {
  pathBasename,
  pathDirname,
  pathExtname,
  relativePath,
} from "@common/util/renderer-path-polyfill";
import { configField } from "../util/configuration";
import { normalizePathForInsertion, saveClipboardImage } from "../util/save-clipboard-image";

const ipcRenderer = window.ipc;

/**
 * These handlers hook into the editor and attempt to intercept events that need
 * to be handled in a way different from the standard CodeMirror way.
 */
export const mdPasteDropHandlers: DOMEventHandlers<void> = {
  paste(event, view) {
    const data = event.clipboardData;
    if (data === null || (data.types.length === 1 && data.types[0] === "text/plain")) {
      return false; // Let the default handler take over
    }

    // Now that we have proper clipboardData to access, we have to determine if
    // this is an image or a text call. Here, we have a set of problems.
    //
    // 1. OS images (and other files) will be represented as file items, so
    //    data.types only includes "Files"
    // 2. Firefox and Chrome will, if the user copies an image, have both the
    //    type "Files" and "text/html", the latter of which often includes the
    //    URL or the image data as a string.
    // 3. Microsoft Office is a POS and will just write EVERYTHING to the
    //    clipboard, i.e. "text/plain", "text/html", "text/rtf", and "image/png"
    // 4. LibreOffice will also write plain, HTML, and RTF, but no image.
    //
    // In effect, we cannot rely on the presence of a "Files" type in the
    // clipboard data to tell us whether we should initiate a paste image or
    // paste text action.
    //
    // BUT, what I found out is that whenever the intention is to paste text,
    // and an image only serves as a fallback, there will be "text/plain" in the
    // clipboard. In other words, as long as there is "text/plain" in the
    // clipboard, the user intends to paste text, not an image.

    const textIntention = data.types.includes("text/plain");
    const basePath = pathDirname(view.state.field(configField).metadata.path);

    const insertions: string[] = [];
    const allPromises: Array<Promise<void>> = [];
    if (textIntention && data.types.includes("text/html")) {
      // The user intends to paste text, and there is formatted HTML in the
      // clipboard that we need to turn into HTML.
      const html = data.getData("text/html");
      const { boldFormatting, italicFormatting } = view.state.field(configField);
      const emphasis = italicFormatting;
      const strong = boldFormatting.includes("*") ? "*" : "_";
      const promise = html2md(html, true, { emphasis, strong })
        .then((md) => {
          insertions.push(md);
        })
        .catch((err) => {
          reportError(err);
          // On error, fall back to the plain text
          insertions.push(data.getData("text/plain"));
        });
      allPromises.push(promise);
    } else if (textIntention) {
      // The user intends to paste text, but there's only plain text in the
      // clipboard.
      const text = data.getData("text/plain");
      insertions.push(text);
    } else {
      // The user intends to paste an image or a series of files
      for (const file of data.files) {
        if (hasImageExt(file.name)) {
          const filePath = window.getPathForFile(file);
          if (filePath === undefined) {
            // This image resides only within the clipboard, so prompt the user
            // to save it down. The command will already wrap everything into
            // `![]()`.
            allPromises.push(
              new Promise((resolve, reject) => {
                saveClipboardImage(basePath, file, file.name)
                  .then((tag) => {
                    if (tag !== undefined) {
                      insertions.push(tag);
                    }
                    resolve();
                  })
                  .catch((err) => reject(err));
              }),
            );
          } else {
            // The file object points to an existing image on disk, so we can
            // directly insert a (relative) path to the image
            insertions.push(`![${file.name}](${relativePath(basePath, filePath)})`);
          }
        } else {
          // Unsupported file type
        }
      }
    }

    Promise.allSettled(allPromises)
      .then(() => {
        // After all promises have been resolved or rejected, the
        // insertions array will contain everything we have to paste.
        const transaction = view.state.replaceSelection(insertions.join("\n"));
        view.dispatch(transaction);
      })
      .catch((err) => reportError(err));

    return true;
  },
  drop(event, view) {
    const dataTransfer = event.dataTransfer;

    if (dataTransfer === null) {
      return false;
    }

    if (dataTransfer.getData("zettlr/document-tab") !== "") {
      return false; // There's a document being dragged, let the MainEditor capture the event
    }

    const zettlrFile = dataTransfer.getData("text/x-zettlr-file");

    if (dataTransfer.files.length === 0 && zettlrFile === "") {
      return false;
    }

    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) {
      return false;
    }

    event.preventDefault();
    event.stopPropagation();

    const cwd = pathDirname(view.state.field(configField).metadata.path);

    // First: Do we have a fileList of files to drop here?
    if (dataTransfer.files.length > 0) {
      const allPromises: Promise<void>[] = [];
      const insertions: string[] = [];
      // We have a list of files being dropped onto the editor --> handle them
      for (const file of dataTransfer.files) {
        const filePath = window.getPathForFile(file);
        const isImage = hasImageExt(file.name);

        if (isImage && filePath !== undefined) {
          // The image resides somewhere on disk -> directly insert
          insertions.push(`![${file.name}](${relativePath(cwd, filePath)})`);
        } else if (isImage && filePath === undefined) {
          // It's an image --> offer to save
          allPromises.push(
            new Promise((resolve, reject) => {
              saveClipboardImage(cwd, file, file.name)
                .then((tag) => {
                  if (tag !== undefined) {
                    insertions.push(tag);
                  }
                  resolve();
                })
                .catch((err) => reject(err));
            }),
          );
        } else if (hasMdOrCodeExt(file.name) && filePath !== undefined) {
          // TODO: We should absolutely here provide the leafId, because
          // otherwise main will simply decide for us instead of us telling
          // which editor pane the user has dropped the file onto.
          // It's a Markdown or supported code file -> tell main to open them
          ipcRenderer
            .invoke("documents-provider", {
              command: "open-file",
              payload: {
                path: filePath,
                newTab: true,
              },
            })
            .catch((e) => reportError(e));
        } else {
          // Unsupported file type -> ignore
        }
      }

      Promise.allSettled(allPromises)
        .then(() => {
          view.dispatch({ changes: { from: pos, insert: insertions.join("\n") } });
        })
        .catch((err) => reportError(err));

      return true;
    } else if (zettlrFile !== "") {
      // We have a Markdown/Code file to insert
      const data = JSON.parse(zettlrFile) as {
        type: "code" | "file" | "directory" | "other";
        path: string;
        id?: string;
      };
      const name = pathBasename(data.path, pathExtname(data.path));
      const pathToInsert = normalizePathForInsertion(data.path, cwd);
      if (data.type === "file") {
        // A workspace document gets the wikilink of the link index, the
        // shortest path suffix that names it alone. A document outside every
        // workspace has no wikilink name, so it gets a Markdown link.
        ipcRenderer
          .invoke("link-provider", { command: "get-link-targets" })
          .then((targets: Record<string, string>) => {
            const target = targets[data.path];
            const insert = target === undefined ? `[${name}](${pathToInsert})` : `[[${target}]]`;
            view.dispatch({ changes: { from: pos, insert } });
          })
          .catch((err) => reportError(err));
      } else if (data.type === "code") {
        // Insert as Md link
        view.dispatch({ changes: { from: pos, insert: `[${name}](${pathToInsert})` } });
      } else if (data.type === "other") {
        if (hasImageExt(data.path)) {
          view.dispatch({ changes: { from: pos, insert: `![${name}](${pathToInsert})` } });
        } else {
          view.dispatch({ changes: { from: pos, insert: `[${name}](${pathToInsert})` } });
        }
      }
      return true;
    }

    return false;
  },
};
