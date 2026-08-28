"use strict";

module.exports = {
  // Mocha's default is 2000ms, which this suite cannot live with: specs here
  // shell out to real pandoc, pandoc-crossref and xvfb probes, and one of them
  // takes 1939ms unloaded -- so any concurrent work tips it over. `just test`
  // and the targeted recipes already pass 30000-240000 explicitly; only
  // `bun run test` fell through to the default, which is the invocation the
  // push gate uses, so the gate failed on a different real-tool spec each run.
  timeout: 120000,
  "node-option": ["import=tsx"],
  require: ["./test/setup.js"],
  extension: ["ts"],
  spec: ["test/**/*.js", "test/**/*.spec.ts"],
};
