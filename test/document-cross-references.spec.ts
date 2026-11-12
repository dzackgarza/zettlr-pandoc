/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The Project facts of a document whose file was removed
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A document with unsaved text stays open after its file is
 *                  removed outside the app (§14). Its cross-reference system
 *                  and the Project roots of its lint come from the folder of
 *                  the document, which is still there: a chapter of a Quarto
 *                  book stays a chapter of that book. Its bibliography comes
 *                  from the text that is linted. Drives the real FSAL after
 *                  its watcher reported the removal.
 *
 * END HEADER
 */

// The harness must load before provider modules, which import Electron.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type FSAL from "source/app/service-providers/fsal";
import type { FSALEventPayload } from "source/app/service-providers/fsal";
import {
  documentCrossReferenceSystem,
  documentLintAuthority,
} from "source/app/util/document-bibliographies";
import { bootFsal } from "./fsal-seam";

const MANIFEST = `project:
  type: book
book:
  title: Surfaces
  chapters:
    - index.md
    - enriques.md
`;

describe("The Project facts of a document whose file was removed", function () {
  let root: string;
  let chapter: string;
  let fsal: FSAL;

  before(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-cross-references-"));
    chapter = path.join(root, "enriques.md");
    await writeFile(path.join(root, "_quarto.yml"), MANIFEST);
    await writeFile(path.join(root, "index.md"), "# Surfaces\n");
    await writeFile(chapter, "# Enriques surfaces {#sec-enriques}\n");
    fsal = await bootFsal(root);

    const removed = new Promise<void>((resolve) => {
      fsal.on("fsal-events", (events: FSALEventPayload[]) => {
        if (events.some((event) => event.event === "unlink" && event.path === chapter)) {
          resolve();
        }
      });
    });
    await rm(chapter);
    await removed;
  });

  after(async function () {
    await fsal.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  it("keeps the cross-reference system of its Quarto book", async function () {
    assert.equal(await documentCrossReferenceSystem(fsal, chapter), "quarto");
  });

  it("keeps the Project root of its lint and the bibliography that its text names", async function () {
    const text = "---\nbibliography: surfaces.bib\n---\n\n# Enriques surfaces {#sec-enriques}\n";
    const authority = await documentLintAuthority(fsal, "", chapter, text);
    assert.deepEqual(authority, {
      bibliographies: [path.join(root, "surfaces.bib")],
      projectRoots: [root],
    });
  });
});
