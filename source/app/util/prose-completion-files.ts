/**
 * Portable prose-completion file utilities.
 *
 * Completion additions use ordinary UTF-8 text: one word or phrase per line,
 * with `#` introducing a comment line. Hunspell dictionaries are accepted as
 * a read-only base vocabulary source; only their explicit word column is
 * projected into completion entries.
 */
import { readFile } from "node:fs/promises";
import { writeTextFile } from "../service-providers/fsal/util/write-text-file";
import { refusedAs } from "./authored-file-error";

/** Parse the explicit word column of a Hunspell `.dic` file. */
export function proseWordsFromHunspellDic(contents: string): string[] {
  const lines = contents.replace(/^\uFEFF/, "").split(/\r?\n/);
  // String.prototype.split always yields at least one element.
  if (/^\s*\d+\s*$/u.test(lines[0])) {
    lines.shift();
  }

  const result: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") continue;

    let word = "";
    let escaped = false;
    for (const char of line) {
      if (escaped) {
        word += char;
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "/" || /\s/u.test(char)) break;
      word += char;
    }
    if (word !== "") result.push(word);
  }
  return result;
}

/** Parse one portable UTF-8 completion catalogue. */
export function parsePortableProseCompletions(contents: string): string[] {
  return contents
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

export function normalizeProseCompletionEntry(entry: string): string {
  return entry.replace(/\s+/gu, " ").trim();
}

/**
 * Adds one entry as the last line of the file, through the one writer of
 * authored text files. Returns false for blank or duplicate entries. The
 * text before the entry stays byte for byte. A refused read or write
 * rejects with an `AuthoredFileError` that names the file and the cause.
 */
export async function appendPortableProseCompletion(
  filePath: string,
  rawEntry: string,
): Promise<boolean> {
  const entry = normalizeProseCompletionEntry(rawEntry);
  if (entry === "") return false;

  const contents = await readFile(filePath, "utf8").catch(refusedAs("read", filePath));
  if (parsePortableProseCompletions(contents).includes(entry)) return false;
  const separator = contents === "" || contents.endsWith("\n") ? "" : "\n";
  await writeTextFile(filePath, `${contents}${separator}${entry}\n`).catch(
    refusedAs("save", filePath),
  );
  return true;
}
