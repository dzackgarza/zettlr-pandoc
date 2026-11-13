/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Open-attachment command spec
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The command "Open attachment" of a citation, from the
 *                  real command over the real citation provider and the real
 *                  document manager. A library can name an attachment file
 *                  that is not on disk: Zotero's BibTeX export writes a file
 *                  name without its braces and doubled spaces. The command
 *                  opens a file that is on disk, and it does not give an
 *                  absent file to the desktop.
 *
 *                  The desktop of the run is an `xdg-open` on the PATH that
 *                  writes the path it gets to a file. Zotero of the run does
 *                  not answer: its address is a closed loopback port.
 *
 * END HEADER
 */

// The harness must load before any provider module: the provider graph
// imports 'electron' at module scope.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import { existsSync } from "fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import type { CiteprocConfig } from "source/app/service-providers/citeproc";
import CiteprocProvider from "source/app/service-providers/citeproc";
import OpenAttachment, {
  type OpenAttachmentServices,
} from "source/app/service-providers/commands/open-attachment";
import type DocumentManager from "source/app/service-providers/documents";
import { parse as parseDirectory } from "source/app/service-providers/fsal/fsal-directory";
import LogProvider from "source/app/service-providers/log";
import { DATABASE_LOADER_THREAD } from "./citeproc-loader-thread";
import { bootDocumentManager } from "./documents-provider-seam";
import { userData } from "./headless-electron-harness.cjs";

const CHICAGO_STYLE = path.resolve("static", "csl-styles", "chicago-author-date.csl");

// Nik80 names an absent file first and a file on disk second; Cob19 names
// only an absent file.
const LIBRARY = `@article{Nik80,
  author = {Nikulin, V. V.},
  title = {Integral symmetric bilinear forms and some of their applications},
  year = {1980},
  journaltitle = {Mathematics of the USSR-Izvestiya},
  file = {Nikulin 1980 - Integral forms.pdf;Nikulin1980.pdf},
}

@article{Cob19,
  author = {Coble, Arthur B.},
  title = {The ten nodes of the rational sextic and of the Cayley symmetroid},
  year = {1919},
  journaltitle = {American Journal of Mathematics},
  file = {Coble 1919 - The ten nodes.pdf},
}
`;

const NOTE =
  "---\nbibliography: library.bib\n---\n\nThe lattice of [@Nik80] and the nodes of [@Cob19].\n";

describe("Open attachment of a citation", function () {
  let directory = "";
  let notePath = "";
  let openedLog = "";
  let originalPath: string;
  let citeproc: CiteprocProvider;
  let documents: DocumentManager;
  let command: OpenAttachment;

  /** The paths that the desktop of the run got, in order. */
  async function opened(): Promise<string[]> {
    if (!existsSync(openedLog)) {
      return [];
    }
    return (await readFile(openedLog, "utf8")).split("\n").filter((line) => line !== "");
  }

  before(async function () {
    directory = await mkdtemp(path.join(os.tmpdir(), "zettlr-open-attachment-"));
    await writeFile(path.join(directory, "library.bib"), LIBRARY);
    await writeFile(path.join(directory, "Nikulin1980.pdf"), "%PDF-1.7\n");
    notePath = path.join(directory, "lattices.md");
    await writeFile(notePath, NOTE);

    const bin = path.join(directory, "bin");
    await mkdir(bin);
    openedLog = path.join(directory, "opened.txt");
    const xdgOpen = path.join(bin, "xdg-open");
    await writeFile(xdgOpen, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${openedLog}'\n`);
    await chmod(xdgOpen, 0o755);
    const inherited = process.env.PATH;
    assert.ok(inherited !== undefined, "the test process has a PATH");
    originalPath = inherited;
    process.env.PATH = `${bin}:${originalPath}`;

    await rm(path.join(userData, "citeproc-cache"), { recursive: true, force: true });
    const config: CiteprocConfig = {
      on: () => {},
      get: () => ({
        appLang: "en-US",
        export: { cslLibrary: "", cslStyle: CHICAGO_STYLE },
      }),
    };
    citeproc = new CiteprocProvider(
      new LogProvider(),
      config,
      path.resolve("static", "csl-locales"),
      DATABASE_LOADER_THREAD,
    );
    await citeproc.boot();
    documents = await bootDocumentManager([directory]);
    const app: OpenAttachmentServices = {
      log: new LogProvider(),
      citeproc,
      documents,
      fsal: {
        getAnyDirectoryDescriptor: async (dirPath: string) => await parseDirectory(dirPath),
      },
      // A loopback port that no server holds: Zotero does not answer.
      config: { get: () => ({ zotero: { localServer: "http://127.0.0.1:9" } }) },
    };
    command = new OpenAttachment(app);
  });

  after(async function () {
    process.env.PATH = originalPath;
    await documents.shutdown();
    await citeproc.shutdown();
    await rm(directory, { recursive: true, force: true });
  });

  beforeEach(async function () {
    await rm(openedLog, { force: true });
  });

  it("opens the file on disk when the first file that the library names is absent", async function () {
    assert.equal(
      await command.run("open-attachment", { filePath: notePath, citekey: "Nik80" }),
      true,
    );
    assert.deepEqual(await opened(), [path.join(directory, "Nikulin1980.pdf")]);
  });

  it("gives the desktop no absent file, and names the cite key when Zotero has no file either", async function () {
    await assert.rejects(
      command.run("open-attachment", { filePath: notePath, citekey: "Cob19" }),
      (failure: Error) => failure.message.includes("Cob19"),
    );
    assert.deepEqual(await opened(), [], "the desktop got no path");
  });
});
