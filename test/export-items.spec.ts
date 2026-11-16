/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The export items of the application
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     `exportItems` makes the one list of what an author exports
 *                  with: the defaults files, the items of the application and
 *                  the items of the settings. The spec gives it each kind of
 *                  declaration, and the settings of a configuration from
 *                  before the export items (`migrateExportItems`).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { PandocProfileMetadata } from "source/app/service-providers/assets";
import {
  exportItemKind,
  exportItemOfProjectEntry,
  exportItems,
  type SettingsExportItem,
} from "source/app/service-providers/commands/exporter/export-items";
import {
  dropExportMathSetting,
  migrateExportItems,
  type StoredExportItems,
} from "source/app/service-providers/config/migrate-export-items";
import { exportItem } from "./export-item-fixtures";

const HTML: PandocProfileMetadata = {
  name: "HTML.yaml",
  reader: "markdown",
  writer: "html",
  isInvalid: false,
};
const LATEX: PandocProfileMetadata = {
  name: "LaTeX.yaml",
  reader: "markdown",
  writer: "latex",
  template: "research_draft.tex",
  isInvalid: false,
};
const BROKEN: PandocProfileMetadata = {
  name: "Broken.yaml",
  isInvalid: true,
  reason: "The defaults file is no YAML mapping.",
};
/** A PDF.yaml of a version before the PDF recipe; userData/defaults keeps it. */
const OLD_PDF: PandocProfileMetadata = {
  name: "PDF.yaml",
  reader: "markdown",
  writer: "pdf",
  isInvalid: false,
};

const UPLOAD: SettingsExportItem = {
  name: "Upload",
  base: "",
  command: "upload-notes",
  extension: "",
};
const HANDOUT: SettingsExportItem = {
  name: "Handout",
  base: "LaTeX.yaml",
  command: "make-handout",
  extension: "pdf",
};

/** The reason of the item with the identity, which cannot run. */
function reasonOf(id: string, settings: SettingsExportItem[]): string {
  const item = exportItems([HTML, LATEX, BROKEN], settings).find(
    (listed) => listed.id === id && listed.isInvalid,
  );
  assert.ok(item?.isInvalid, `the item ${id} is in the list and cannot run`);
  return item.reason;
}

describe("The export items of the application", function () {
  it("lists the defaults files, the items of the application and the items of the settings, in that order", function () {
    assert.deepEqual(
      exportItems([HTML, BROKEN], [UPLOAD]).map((item) => [item.id, item.origin, item.isInvalid]),
      [
        ["HTML.yaml", "defaults-file", false],
        ["Broken.yaml", "defaults-file", true],
        ["PDF.yaml", "application", false],
        ["Textbundle.yaml", "application", false],
        ["Textpack.yaml", "application", false],
        ["Upload", "settings", false],
      ],
    );
  });

  it("gives a defaults file a Pandoc engine with its reader, its writer and its template", function () {
    assert.deepEqual(exportItem("LaTeX.yaml", [LATEX]), {
      id: "LaTeX.yaml",
      origin: "defaults-file",
      isInvalid: false,
      engine: {
        kind: "pandoc",
        defaultsFile: "LaTeX.yaml",
        reader: "markdown",
        writer: "latex",
        template: "research_draft.tex",
      },
      post: undefined,
    });
    const html = exportItem("HTML.yaml", [HTML]);
    assert.ok(html.engine.kind === "pandoc");
    assert.equal(html.engine.template, undefined, "a defaults file without a template");
  });

  it("keeps the reason of a defaults file that cannot run", function () {
    assert.equal(reasonOf("Broken.yaml", []), "The defaults file is no YAML mapping.");
  });

  it("runs the PDF recipe for PDF.yaml when the defaults hold an old PDF.yaml", function () {
    const listed = exportItems([OLD_PDF], []).filter((item) => item.id === "PDF.yaml");

    assert.equal(listed.length, 1, "one item has the name");
    const [pdf] = listed;
    assert.ok(!pdf.isInvalid);
    assert.deepEqual(pdf.engine, { kind: "recipe", recipe: "compile-pandoc" });
  });

  it("makes a command of an item of the settings without a base", function () {
    const item = exportItem("Upload", [], [UPLOAD]);

    assert.deepEqual(item.engine, { kind: "command", command: "upload-notes" });
    assert.equal(item.post, undefined);
    assert.equal(exportItemKind(item), "command");
  });

  it("runs the base of an item of the settings and then its command", function () {
    const item = exportItem("Handout", [LATEX], [HANDOUT]);

    assert.deepEqual(item.engine, {
      kind: "pandoc",
      defaultsFile: "LaTeX.yaml",
      reader: "markdown",
      writer: "latex",
      template: "research_draft.tex",
    });
    assert.deepEqual(item.post, { command: "make-handout", extension: "pdf" });
    assert.equal(exportItemKind(item), "script");
  });

  it("says why an item of the settings cannot run", function () {
    assert.equal(
      reasonOf("No base", [{ ...HANDOUT, name: "No base", base: "Slides.yaml" }]),
      'The base "Slides.yaml" of the export item is no defaults file.',
    );
    assert.equal(
      reasonOf("Broken base", [{ ...HANDOUT, name: "Broken base", base: "Broken.yaml" }]),
      'The base "Broken.yaml" of the export item cannot run: The defaults file is no YAML mapping.',
    );
    assert.equal(
      reasonOf("No extension", [{ ...HANDOUT, name: "No extension", extension: " " }]),
      "The export item has a base and no extension for the file that its command writes.",
    );
    assert.equal(
      reasonOf("No command", [{ ...UPLOAD, name: "No command", command: "" }]),
      "The export item has no command.",
    );
    assert.equal(
      reasonOf("PDF.yaml", [{ ...UPLOAD, name: "PDF.yaml" }]).startsWith('The name "PDF.yaml"'),
      true,
      "the name of an item of the application is taken",
    );
  });

  it("runs neither of two items of the settings with one name", function () {
    const twice = exportItems([], [UPLOAD, { ...UPLOAD, command: "upload-drafts" }]).filter(
      (item) => item.id === "Upload",
    );

    assert.deepEqual(
      twice.map((item) => item.isInvalid),
      [true, true],
    );
  });

  it("replaces a defaults file with the item of the settings of its name", function () {
    const listed = exportItems([HTML, LATEX], [{ ...HANDOUT, name: "HTML.yaml" }]).filter(
      (item) => item.id === "HTML.yaml",
    );

    assert.deepEqual(
      listed.map((item) => item.origin),
      ["settings"],
    );
  });

  it("names the kind of each engine as an author reads it", function () {
    assert.equal(exportItemKind(exportItem("HTML.yaml", [HTML])), "html");
    assert.equal(exportItemKind(exportItem("PDF.yaml")), "compile-pandoc");
    assert.equal(exportItemKind(exportItem("Textpack.yaml")), "textpack");
  });

  it("finds the item of an entry of a Project by its identity, and a command by its command line", function () {
    const items = exportItems([HTML], [UPLOAD]);

    assert.equal(exportItemOfProjectEntry("HTML.yaml", items)?.id, "HTML.yaml");
    assert.equal(exportItemOfProjectEntry("Upload", items)?.id, "Upload");
    assert.equal(
      exportItemOfProjectEntry("upload-notes", items)?.id,
      "Upload",
      "a Project file from before the export items names a command by its command line",
    );
    assert.equal(exportItemOfProjectEntry("Slides.yaml", items), undefined);
  });
});

describe("The export items of a configuration from before the export items", function () {
  it("makes items of the commands and of the scripts, the commands first", function () {
    const stored: StoredExportItems = {
      customCommands: [{ displayName: "Upload", command: "upload-notes" }],
      scripts: [
        { name: "Handout", profile: "LaTeX.yaml", command: "make-handout", extension: "pdf" },
      ],
    };

    migrateExportItems(stored);

    assert.deepEqual(stored, { items: [UPLOAD, HANDOUT] });
  });

  it("makes items of a configuration with one of the two settings", function () {
    const stored: StoredExportItems = {
      customCommands: [{ displayName: "Upload", command: "upload-notes" }],
    };

    migrateExportItems(stored);

    assert.deepEqual(stored, { items: [UPLOAD] });
  });

  it("leaves a configuration with items as it is", function () {
    const stored: StoredExportItems = { items: [HANDOUT] };

    migrateExportItems(stored);

    assert.deepEqual(stored, { items: [HANDOUT] });
  });

  it("leaves a configuration without export commands and scripts without items", function () {
    const stored: StoredExportItems = {};

    migrateExportItems(stored);

    assert.deepEqual(stored, {});
  });

  it("removes the setting of the math headers of the application, which the template replaced", function () {
    const stored: StoredExportItems = { items: [HANDOUT], injectMathHeaders: false };

    dropExportMathSetting(stored);

    assert.deepEqual(stored, { items: [HANDOUT] });
  });
});
