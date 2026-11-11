/**
 * BEGIN HEADER
 *
 * Contains:        Utility function
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file contains a utility function to extract
 *                  BibTex attachment entries from such a file.
 *
 * END HEADER
 */

import pdfSorter from "@common/util/sort-by-pdf";
import type LogProvider from "@providers/log";
import { bibtex } from "astrocite";
import { type BracedComment } from "astrocite-bibtex";
import path from "path";

const AstrociteAST = bibtex.AST;

type BibTexAttachments = Record<string, string[] | false>;

// The `file` field follows the parser of Zotero's BibTeX translator
// (`parseFilePathRecord` and `decodeFilePathComponent` in
// https://github.com/zotero/translators/blob/master/BibTeX.js). A field holds
// records apart by `;`. A record is a path, or `title:path:type` (JabRef,
// Zotero). A backslash before a character of a part makes that character
// literal, so a title or a path can hold `:`, `;` and `\`.

/** Splits `text` at each `separator` that no backslash makes literal. */
function splitUnescaped(text: string, separator: ":" | ";"): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\\") {
      index++;
    } else if (text[index] === separator) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** The paths that a `file` field names, PDF files first. */
function attachmentPaths(field: string, baseDir: string, logger?: LogProvider): string[] {
  const paths: string[] = [];
  for (const record of splitUnescaped(field, ";")) {
    const parts = splitUnescaped(record, ":").map((part) =>
      part.replace(/\\([^A-Za-z0-9.])/g, "$1"),
    );
    if (parts.length !== 1 && parts.length !== 3) {
      logger?.warning(`[extractBibtexAttachments] Unknown file record format: ${record}`);
      continue;
    }
    const filePath = parts.length === 1 ? parts[0] : parts[1];
    if (filePath !== "") {
      paths.push(path.isAbsolute(filePath) ? filePath : path.join(baseDir, filePath));
    }
  }
  return paths.sort(pdfSorter);
}

/**
 * Returns a dictionary in the form citeKey: Array(files)
 * @param {String} fileContents The contents of a valid BibTex file
 * @param {String} baseDir The base directory to use in case the links are relative.
 * @return {Object} Returns a dictionary containing all extracted files
 */
export default function extractBibtexAttachments(
  fileContents: string,
  baseDir: string,
  logger?: LogProvider,
): BibTexAttachments {
  const ast = AstrociteAST.parse(fileContents);
  // Return value will be a fast-access dictionary
  const files: BibTexAttachments = {};

  // First we search for the jabref comments containing the files' root directories
  const comments = ast.children.filter((item) => item.kind === "BracedComment") as BracedComment[];
  // The format of the value field is 'jabref-meta: fileDirectory*:<path>;'
  const jabrefComments = comments.filter((item) => item.value.startsWith("jabref-meta:"));
  for (const entry of jabrefComments) {
    const value = entry.value.split(":").map((e) => e.trim());
    if (value[1].startsWith("fileDirectory")) {
      baseDir = value[2].replace(/;/g, "");
      logger?.info(
        `[extractBibtexAttachments] Found a fileDirectory, overwriting baseDir: ${baseDir}`,
      );
      break;
    }
  }

  // Now let's see what entries have files attached.
  // Such attributes are stored in properties within the entry.
  for (const entry of ast.children) {
    if (entry.kind !== "Entry") {
      continue;
    }

    for (const property of entry.properties) {
      if (property.key === "file") {
        const firstValue = property.value[0];
        if (firstValue.kind !== "String" && firstValue.kind !== "Text") {
          continue;
        }

        const paths = attachmentPaths(firstValue.value, baseDir, logger);
        if (paths.length > 0) {
          files[entry.id] = paths;
        }
      }
    }

    // An entry without a value at this point has no attached files. It
    // gets false, not an empty array, so that `!files[key]` is true
    // for it: an empty array is truthy.
    if (files[entry.id] === undefined) {
      files[entry.id] = false;
    }
  }

  return files;
}
