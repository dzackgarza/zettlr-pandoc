/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Text file write and creation
 * CVM-Role:        Utility
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Writes the text of a file. A reader of the file gets the
 *                  text before the write or the text after it, and a write
 *                  that stops leaves the text before it: the text goes to a
 *                  temporary file beside the target, and a rename puts that
 *                  file in the place of the target (write-file-atomic).
 *
 *                  A rename gives the path a new file. Where a new file
 *                  cannot be what the old file was, the text goes into the
 *                  old file in place, and a reader can then get a part of
 *                  it. The decision is that of the value "auto" of Vim's
 *                  'backupcopy' option (`:help 'backupcopy'`): Vim writes in
 *                  place when the file is a link, has other names, belongs to
 *                  another user or a group that it cannot set, or is in a
 *                  directory where it cannot create a file.
 *
 *                  The creation of a new file is a call of its own. It
 *                  never replaces a file.
 *
 * END HEADER
 */

import { constants, promises as fs, lstatSync } from "fs";
import path from "path";
import writeFileAtomic from "write-file-atomic";
import { pathExists } from "./fs";

/**
 * Whether a new file with the mode of the file at `filePath` can take its
 * place and be the same file to the author and to every other program.
 * Rejects when the file exists and the user may not write it.
 */
async function replacedByRename(filePath: string): Promise<boolean> {
  const directory = path.dirname(filePath);
  if (!(await pathExists(directory, constants.W_OK | constants.X_OK))) {
    return false;
  }
  const stats = lstatSync(filePath, { throwIfNoEntry: false });
  if (stats === undefined) {
    return true;
  }
  // A symbolic link, and a file with a second name: a rename would put a
  // file in the place of the link, and leave the old text under the other
  // name.
  if (!stats.isFile() || stats.nlink > 1) {
    return false;
  }
  // The new file belongs to this user, with a group of this user.
  if (stats.uid !== process.getuid?.() || process.getgroups?.().includes(stats.gid) !== true) {
    return false;
  }
  // A rename needs write permission to the directory only. The permission
  // of the file decides whether its text may change.
  await fs.access(filePath, constants.W_OK);
  return true;
}

/**
 * Writes `contents` to the file at `filePath`, and creates the file when it
 * does not exist.
 */
export async function writeTextFile(filePath: string, contents: string): Promise<void> {
  if (await replacedByRename(filePath)) {
    await writeFileAtomic(filePath, contents, "utf-8");
  } else {
    await fs.writeFile(filePath, contents, "utf-8");
  }
}

/**
 * Creates the file at `filePath` with `contents`. The creation replaces
 * nothing: when something is at the path, the file system refuses the call
 * with `EEXIST` (the flag `wx`, `O_CREAT | O_EXCL` of open(2)), also when it
 * arrived after a check of the caller.
 */
export async function createTextFile(filePath: string, contents: string): Promise<void> {
  await fs.writeFile(filePath, contents, { encoding: "utf-8", flag: "wx" });
}
