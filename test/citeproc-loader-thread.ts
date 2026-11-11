/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The thread program of a citation database load, for specs
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     A spec gives this path to the CiteprocProvider. It is the
 *                  source of the program that the built app loads as
 *                  `database-loader-worker.cjs`. The worker thread of a spec
 *                  inherits the TypeScript loader of the Mocha process.
 *
 * END HEADER
 */

import path from "path";

export const DATABASE_LOADER_THREAD = path.resolve(
  "source",
  "app",
  "service-providers",
  "citeproc",
  "util",
  "database-loader-worker.ts",
);
