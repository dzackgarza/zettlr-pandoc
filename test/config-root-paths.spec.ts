/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Root paths of the configuration
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Which open files and workspaces the configuration keeps:
 *                  a file inside an open workspace is no root file, and a
 *                  file beside it is.
 *
 * END HEADER
 */

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { strict as assert } from "assert";
import {
  consolidateRootPaths,
  rootPathsOnDisk,
} from "source/app/service-providers/config/root-paths";

describe("root paths of the configuration", function () {
  it("keeps a root file whose path starts with the path of an open workspace", function () {
    assert.deepEqual(
      consolidateRootPaths({
        openFiles: ["/n/proj-notes.md", "/n/proj/chapter.md", "/n/project/readme.md"],
        openWorkspaces: ["/n/proj"],
      }),
      {
        openFiles: ["/n/proj-notes.md", "/n/project/readme.md"],
        openWorkspaces: ["/n/proj"],
      },
    );
  });

  it("removes every root file that an open workspace holds", function () {
    assert.deepEqual(
      consolidateRootPaths({
        openFiles: ["/u/notes/a.md", "/u/notes/b.md", "/u/other.md", "/u/notes/zeta/c.md"],
        openWorkspaces: ["/u/notes"],
      }),
      { openFiles: ["/u/other.md"], openWorkspaces: ["/u/notes"] },
    );
  });

  it("keeps a workspace that is inside another open workspace", function () {
    assert.deepEqual(
      consolidateRootPaths({
        openFiles: ["/u/notes/zeta/c.md"],
        openWorkspaces: ["/u/notes", "/u/notes/zeta"],
      }),
      { openFiles: [], openWorkspaces: ["/u/notes", "/u/notes/zeta"] },
    );
  });
});

describe("root paths of the configuration on disk", function () {
  let scratch: string;
  let file: string;
  let workspace: string;
  let unreachableFile: string;
  let unreachableWorkspace: string;

  before(async function () {
    // The real path: a root is named with each symbolic link resolved.
    scratch = await realpath(await mkdtemp(path.join(tmpdir(), "zettlr-root-paths-")));
    file = path.join(scratch, "note.md");
    workspace = path.join(scratch, "workspace");
    // A symbolic link to itself: a look at a path below it fails with ELOOP,
    // as a look at a path on a mount that went away fails.
    const mount = path.join(scratch, "mount");
    unreachableFile = path.join(mount, "note.md");
    unreachableWorkspace = path.join(mount, "workspace");
    await writeFile(file, "Note\n");
    await mkdir(workspace);
    await symlink(mount, mount);
  });

  after(async function () {
    await rm(scratch, { recursive: true, force: true });
  });

  it("removes every root path that is not on disk", function () {
    const missing = (name: string): string => path.join(scratch, name);
    const reported: string[] = [];
    assert.deepEqual(
      rootPathsOnDisk(
        {
          openFiles: [missing("a.md"), missing("b.md"), file, workspace],
          openWorkspaces: [missing("first"), missing("second"), workspace, file],
        },
        (rootPath) => reported.push(rootPath),
      ),
      { openFiles: [file], openWorkspaces: [workspace] },
    );
    assert.deepEqual(reported, []);
  });

  it("names each root by its path with each symbolic link resolved (#57)", async function () {
    // A workspace that the author opened through a link to its folder, and a
    // file through a link to the folder that holds it.
    const linkedWorkspace = path.join(scratch, "linked-workspace");
    const linkedFolder = path.join(scratch, "linked-folder");
    await symlink(workspace, linkedWorkspace);
    await symlink(scratch, linkedFolder);

    assert.deepEqual(
      rootPathsOnDisk(
        { openFiles: [path.join(linkedFolder, "note.md")], openWorkspaces: [linkedWorkspace] },
        (rootPath) => assert.fail(`${rootPath} can be examined`),
      ),
      { openFiles: [file], openWorkspaces: [workspace] },
      "a file under two names is one root, and the documents of a workspace have one name each",
    );
  });

  it("keeps and reports a root path that the filesystem cannot examine", function () {
    const reported: Array<{ rootPath: string; code: string | undefined }> = [];
    assert.deepEqual(
      rootPathsOnDisk(
        { openFiles: [unreachableFile, file], openWorkspaces: [unreachableWorkspace, workspace] },
        (rootPath, error) => reported.push({ rootPath, code: error.code }),
      ),
      { openFiles: [unreachableFile, file], openWorkspaces: [unreachableWorkspace, workspace] },
    );
    assert.deepEqual(reported, [
      { rootPath: unreachableFile, code: "ELOOP" },
      { rootPath: unreachableWorkspace, code: "ELOOP" },
    ]);
  });
});
