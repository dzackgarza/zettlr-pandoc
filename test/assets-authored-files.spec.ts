/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Tests of refused operations on the files of the Assets window
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The Assets window edits files that the author owns: Lua
 *                  filters, export profiles and the custom CSS. An operation
 *                  that the filesystem refuses rejects with an error that
 *                  names the operation and the file; it does not answer a
 *                  value that a window can take for a success. These tests
 *                  run the real providers over files on disk.
 *
 * END HEADER
 */

import "./headless-electron-harness.cjs";
import { strict as assert } from "node:assert";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import AssetsProvider from "source/app/service-providers/assets";
import ConfigProvider from "source/app/service-providers/config";
import CssProvider from "source/app/service-providers/css";
import LogProvider from "source/app/service-providers/log";
import { AuthoredFileError, type AuthoredFileOperation } from "source/app/util/authored-file-error";
import { userData } from "./headless-electron-harness.cjs";

const FILTER = "-- Leaves each element as it is.\nreturn {}\n";
const OTHER_FILTER = "-- Numbers each section.\nreturn {}\n";
const PROFILE = "reader: markdown\nwriter: html\n";
const OTHER_PROFILE = "reader: markdown\nwriter: latex\n";
const CSS = "body { hyphens: auto; }\n";

/** The refusal of one operation: its kind and the file it names. */
interface Refusal {
  operation: AuthoredFileOperation;
  filePath: string;
}

/** The refusal that a call rejects with. */
async function refusalOf(call: Promise<string | void>): Promise<Refusal> {
  const failure = await call.then(
    (value) => assert.fail(`the call answered ${String(value)} and did not reject`),
    (reason: Error) => reason,
  );
  assert.ok(failure instanceof AuthoredFileError, `rejected with ${failure.name}`);
  return { operation: failure.operation, filePath: failure.filePath };
}

describe("The files of the Assets window", function () {
  const filters = path.join(userData, "lua-filter");
  const defaults = path.join(userData, "defaults");
  const customCss = path.join(userData, "custom.css");
  let assets: AssetsProvider;
  let css: CssProvider;

  before(async function () {
    const log = new LogProvider();
    assets = new AssetsProvider(log, new ConfigProvider(log, [path.resolve("static", "lang")]));
    css = new CssProvider(log);
  });

  beforeEach(async function () {
    for (const directory of [filters, defaults]) {
      await mkdir(directory, { recursive: true });
      await chmod(directory, 0o700);
      for (const entry of await readdir(directory)) {
        await rm(path.join(directory, entry));
      }
    }
    await writeFile(path.join(filters, "numbering.lua"), FILTER);
    await writeFile(path.join(defaults, "Handout.yaml"), PROFILE);
    await rm(customCss, { force: true });
    await writeFile(customCss, CSS);
  });

  after(async function () {
    await chmod(filters, 0o700);
    await chmod(defaults, 0o700);
    await assets.shutdown();
  });

  describe("a Lua filter", function () {
    const file = path.join(filters, "numbering.lua");

    it("rejects a save that the file refuses", async function () {
      await chmod(file, 0o400);

      const refusal = await refusalOf(assets.setFilter("numbering.lua", "return nil\n"));

      assert.deepEqual(refusal, { operation: "save", filePath: file });
      assert.equal(await readFile(file, "utf8"), FILTER);
    });

    it("rejects a rename that the directory refuses", async function () {
      await chmod(filters, 0o500);

      const refusal = await refusalOf(assets.renameFilter("numbering.lua", "sections"));

      assert.deepEqual(refusal, { operation: "rename", filePath: file });
      assert.deepEqual(await readdir(filters), ["numbering.lua"]);
    });

    it("rejects a rename to the name of another filter", async function () {
      const other = path.join(filters, "sections.lua");
      await writeFile(other, OTHER_FILTER);

      const refusal = await refusalOf(assets.renameFilter("numbering.lua", "sections"));

      assert.deepEqual(refusal, { operation: "rename", filePath: file });
      assert.equal(await readFile(other, "utf8"), OTHER_FILTER);
      assert.equal(await readFile(file, "utf8"), FILTER);
    });

    it("creates a filter under a name that no filter has", async function () {
      const created = await assets.createFilter("sections");

      assert.equal(created, "sections.lua");
      assert.equal(await readFile(path.join(filters, "sections.lua"), "utf8"), "");
    });

    it("rejects the creation of a filter under the name of another filter", async function () {
      const refusal = await refusalOf(assets.createFilter("numbering"));

      assert.deepEqual(refusal, { operation: "create", filePath: file });
      assert.equal(await readFile(file, "utf8"), FILTER);
    });

    it("rejects a removal that the directory refuses", async function () {
      await chmod(filters, 0o500);

      const refusal = await refusalOf(assets.removeFilter("numbering.lua"));

      assert.deepEqual(refusal, { operation: "remove", filePath: file });
      assert.deepEqual(await readdir(filters), ["numbering.lua"]);
    });

    it("rejects the read of a file that refuses it", async function () {
      await chmod(file, 0o000);

      const failure = await assets.getFilter("numbering.lua").then(
        (text) => assert.fail(`the read answered ${JSON.stringify(text)}`),
        (reason: Error) => reason,
      );

      assert.ok(failure instanceof AuthoredFileError, `rejected with ${failure.name}`);
      assert.deepEqual([failure.operation, failure.filePath], ["read", file]);
    });
  });

  describe("an export profile", function () {
    const file = path.join(defaults, "Handout.yaml");

    it("rejects a save that the file refuses", async function () {
      await chmod(file, 0o400);

      const refusal = await refusalOf(
        assets.setDefaultsFile("Handout.yaml", "reader: markdown\nwriter: latex\n", true),
      );

      assert.deepEqual(refusal, { operation: "save", filePath: file });
      assert.equal(await readFile(file, "utf8"), PROFILE);
    });

    it("rejects a rename that the directory refuses", async function () {
      await chmod(defaults, 0o500);

      const refusal = await refusalOf(assets.renameDefaultsFile("Handout.yaml", "Notes.yaml"));

      assert.deepEqual(refusal, { operation: "rename", filePath: file });
      assert.deepEqual(await readdir(defaults), ["Handout.yaml"]);
    });

    it("rejects a rename to the name of another profile", async function () {
      const other = path.join(defaults, "Notes.yaml");
      await writeFile(other, OTHER_PROFILE);

      const refusal = await refusalOf(assets.renameDefaultsFile("Handout.yaml", "Notes.yaml"));

      assert.deepEqual(refusal, { operation: "rename", filePath: file });
      assert.equal(await readFile(other, "utf8"), OTHER_PROFILE);
      assert.equal(await readFile(file, "utf8"), PROFILE);
    });

    it("creates a profile under a name that no profile has", async function () {
      const created = await assets.createDefaultsFile("Notes", OTHER_PROFILE);

      assert.equal(created, "Notes.yaml");
      assert.equal(await readFile(path.join(defaults, "Notes.yaml"), "utf8"), OTHER_PROFILE);
    });

    it("rejects the creation of a profile under the name of another profile", async function () {
      const refusal = await refusalOf(assets.createDefaultsFile("Handout.yaml", OTHER_PROFILE));

      assert.deepEqual(refusal, { operation: "create", filePath: file });
      assert.equal(await readFile(file, "utf8"), PROFILE);
    });

    it("rejects a removal that the directory refuses", async function () {
      await chmod(defaults, 0o500);

      const refusal = await refusalOf(assets.removeDefaultsFile("Handout.yaml"));

      assert.deepEqual(refusal, { operation: "remove", filePath: file });
      assert.deepEqual(await readdir(defaults), ["Handout.yaml"]);
    });
  });

  describe("the custom CSS", function () {
    it("rejects a save that the file refuses", async function () {
      await chmod(customCss, 0o400);

      const refusal = await refusalOf(css.set("body { hyphens: none; }\n"));

      assert.deepEqual(refusal, { operation: "save", filePath: customCss });
      assert.equal(await readFile(customCss, "utf8"), CSS);
    });
  });
});
