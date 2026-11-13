/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Document title spec
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A document has one title and one listed name (#203). The
 *                  title is what a tab shows: the YAML title, the first
 *                  heading, the first sentence, the file name without its
 *                  extension. The listed name follows the setting
 *                  `fileNameDisplay` and the setting that shows Markdown
 *                  extensions, as the file manager does. The hover preview of
 *                  a wikilink shows the listed name of its target.
 *
 * END HEADER
 */

// The harness must load before any provider module.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import FilePathFindMetaData, {
  type FileMetadataServices,
} from "source/app/service-providers/commands/file-find-and-return-meta-data";
import { parse as parseFile } from "source/app/service-providers/fsal/fsal-file";
import getMarkdownFileParser from "source/app/service-providers/fsal/util/file-parser";
import { WikilinkIndex } from "source/common/util/wikilink-resolution";
import type { FileNameDisplay } from "source/types/common/fsal";

describe("document title", function () {
  let workspace: string;

  beforeEach(async function () {
    workspace = await mkdtemp(path.join(os.tmpdir(), "zettlr-document-title-"));
  });

  afterEach(async function () {
    await rm(workspace, { recursive: true, force: true });
  });

  async function hoverTitle(
    fileName: string,
    text: string,
    fileNameDisplay: FileNameDisplay,
    markdownFileExtensions: boolean,
  ): Promise<string> {
    const target = path.join(workspace, fileName);
    const source = path.join(workspace, "source.md");
    await writeFile(target, text, "utf8");
    await writeFile(source, `See [[${path.basename(fileName, ".md")}]].\n`, "utf8");
    const descriptor = await parseFile(
      target,
      null,
      getMarkdownFileParser("(\\d{14})", "link|title"),
    );
    const index = new WikilinkIndex(
      [target, source].map((documentPath) => ({
        path: documentPath,
        root: workspace,
        id: "",
        title: undefined,
        aliases: [],
      })),
    );
    const services: FileMetadataServices = {
      links: index,
      fsal: {
        getDescriptorFor: async () => descriptor,
        loadAnySupportedFile: async (filePath: string) => await readFile(filePath, "utf8"),
      },
      config: { get: () => ({ fileNameDisplay, display: { markdownFileExtensions } }) },
    };
    const result = await new FilePathFindMetaData(services).run("file-find-and-return-meta-data", {
      linkContents: path.basename(fileName, ".md"),
      sourcePath: source,
    });
    assert.equal(result.status, "resolved");
    return result.title;
  }

  // The file manager lists `note` when the Markdown extensions are hidden
  it("titles a hover preview with the name that the file manager lists", async function () {
    assert.equal(
      await hoverTitle("note.md", "Some prose without a heading.\n", "filename", false),
      "note",
    );
    assert.equal(
      await hoverTitle("note.md", "Some prose without a heading.\n", "filename", true),
      "note.md",
    );
    assert.equal(
      await hoverTitle("genus.md", "# Genus of a lattice\n\nText.\n", "title+heading", false),
      "Genus of a lattice",
    );
  });
});
