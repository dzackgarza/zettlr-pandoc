const { execFileSync } = require("child_process");

module.exports = {
  /**
   * The short hash of the checked-out commit. The webpack configurations bake
   * it into the bundles; git failing (no repository) fails the build.
   */
  gitCommitHash: function () {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: __dirname,
      encoding: "utf-8",
    }).trim();
  },
};
