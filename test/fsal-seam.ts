/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        FSAL test seam
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Boots the REAL FSAL over one workspace directory, with its
 *                  watcher on the real files. A spec must import the headless
 *                  Electron harness before this.
 *
 * END HEADER
 */

import path from "node:path";
import ConfigProvider from "source/app/service-providers/config";
import FSAL from "source/app/service-providers/fsal";
import LogProvider from "source/app/service-providers/log";
import LongRunningTaskProvider from "source/app/service-providers/long-running-tasks";
import { unexpectedStoreWriteFailure } from "./store-write-failure";

/**
 * A booted FSAL whose only workspace is `root`. The file filters are off, so
 * the FSAL lists every path: the temporary file of an atomic write is a
 * listed path like any other file.
 */
export async function bootFsal(root: string): Promise<FSAL> {
  return await boot(root, true);
}

/**
 * A booted FSAL whose only workspace is `root`, with the file filters of the
 * configuration template on, as the application starts.
 */
export async function bootFilteredFsal(root: string): Promise<FSAL> {
  return await boot(root, false);
}

async function boot(root: string, showIgnored: boolean): Promise<FSAL> {
  const log = new LogProvider();
  // The real provider with the values of the configuration template. It is
  // not booted: a boot reads the configuration file and opens the onboarding
  // window.
  const config = new ConfigProvider(
    log,
    [path.resolve("static", "lang")],
    unexpectedStoreWriteFailure,
  );
  config.set("app.openWorkspaces", [root]);
  config.set("fileManager.showIgnored", showIgnored);

  const fsal = new FSAL(log, config, new LongRunningTaskProvider(log));
  await fsal.boot();
  return fsal;
}
