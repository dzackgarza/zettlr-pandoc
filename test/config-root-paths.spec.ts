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

import { strict as assert } from "assert";
import { consolidateRootPaths } from "source/app/service-providers/config/root-paths";

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
