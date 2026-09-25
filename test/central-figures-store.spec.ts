import { strict as assert } from "assert";
import path from "path";
import { resolveCentralFiguresDirectory } from "source/app/util/central-figures-store";

describe("central figures directory resolution", function () {
  it("uses explicit configuration before environment and canonical fallback", function () {
    const home = path.join(path.sep, "home", "author");
    const configured = path.join(path.sep, "srv", "figures");
    const environment = path.join(path.sep, "env", "figures");
    assert.equal(
      resolveCentralFiguresDirectory(configured, home, { FIGURES_SOURCE_DIR: environment }),
      configured,
    );
  });

  it("uses FIGURES_SOURCE_DIR when no explicit figures directory is configured", function () {
    const home = path.join(path.sep, "home", "author");
    const environment = path.join(path.sep, "env", "figures");
    assert.equal(
      resolveCentralFiguresDirectory("", home, { FIGURES_SOURCE_DIR: environment }),
      environment,
    );
  });

  it("falls back to the canonical ~/.pandoc/figures tree", function () {
    const home = path.join(path.sep, "home", "author");
    assert.equal(
      resolveCentralFiguresDirectory("", home, {}),
      path.join(home, ".pandoc", "figures"),
    );
  });
});
