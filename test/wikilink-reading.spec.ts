/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Tests of the reading of the wikilinks of a document
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The wikilinks of a document are the links that the editor
 *                  parses, with the link format of the settings
 *                  (`zkn.linkFormat`): `[[x]]` in code is no link, and in
 *                  `[[title|link]]` the target is the part after the pipe. The
 *                  FSAL index and the Flowmark lint context read the same
 *                  links (#203).
 *
 * END HEADER
 */

import "./headless-electron-harness.cjs";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type FSAL from "source/app/service-providers/fsal";
import { buildFlowmarkLintContext } from "source/app/util/flowmark-lint-context";
import { WikilinkIndex } from "source/common/util/wikilink-resolution";
import { bootFilteredFsal } from "./fsal-seam";

/** A note with two links, and the text of a link in a code block and in code. */
const TITLE_FIRST = [
  "# Notes",
  "",
  "See [[the lattices|lattices]] and [[genus]].",
  "",
  "```",
  "[[in a code block]]",
  "```",
  "",
  "The text `[[in code]]` is code.",
  "",
].join("\n");

const LINK_FIRST = TITLE_FIRST.replace("[[the lattices|lattices]]", "[[lattices|the lattices]]");

describe("The wikilinks of a document", function () {
  let root: string;

  before(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-wikilink-reading-"));
    await writeFile(path.join(root, "lattices.md"), "# Lattices\n");
    await writeFile(path.join(root, "genus.md"), "# Genus\n");
  });

  after(async function () {
    await rm(root, { recursive: true, force: true });
  });

  describe("in the FSAL with the link format title|link", function () {
    let fsal: FSAL;
    let notes: string;

    before(async function () {
      notes = path.join(root, "notes.md");
      await writeFile(notes, TITLE_FIRST);
      fsal = await bootFilteredFsal(root, (config) => {
        config.set("zkn.linkFormat", "title|link");
      });
    });

    after(async function () {
      await fsal.shutdown();
      await rm(notes);
    });

    it("are the parts after the pipe, and no text in code", async function () {
      const descriptor = await fsal.getDescriptorFor(notes);
      assert.equal(descriptor.type, "file");
      assert.deepEqual(descriptor.type === "file" ? descriptor.links : null, ["lattices", "genus"]);
    });
  });

  describe("in the Flowmark lint context", function () {
    function contextFor(text: string, linkFormat: "link|title" | "title|link") {
      const documentPath = path.join(root, "notes.md");
      return buildFlowmarkLintContext(text, documentPath, {
        homeDirectory: root,
        env: {},
        macroSources: [],
        linkFormat,
        wikilinks: new WikilinkIndex(
          ["lattices.md", "genus.md"].map((name) => ({
            path: path.join(root, name),
            root,
            id: "",
            title: undefined,
            aliases: [],
          })),
        ),
        tikzRenderConfig: {
          tikzAssetDir: root,
          templatePath: path.join(root, "no-template.tex"),
          cacheDir: root,
          timeoutMs: 30_000,
          env: {},
        },
      });
    }

    // The resolution of each link of the text, and of no text in code.
    function resolutions() {
      return {
        resolutions: Object.fromEntries(
          ["lattices", "genus"].map((name) => [
            name,
            {
              status: "resolved",
              path: path.join(root, `${name}.md`),
              canonical: name,
              relative: false,
            },
          ]),
        ),
      };
    }

    it("resolves the targets of the links and no text in code", async function () {
      const context = await contextFor(LINK_FIRST, "link|title");
      assert.deepEqual(context.wikilinks, resolutions());
    });

    it("resolves the parts after the pipe with the link format title|link", async function () {
      const context = await contextFor(TITLE_FIRST, "title|link");
      assert.deepEqual(context.wikilinks, resolutions());
    });
  });
});
