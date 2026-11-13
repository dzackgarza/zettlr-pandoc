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

import { strict as assert } from "node:assert";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import ConfigProvider from "source/app/service-providers/config";
import FSAL, { type FSALEventPayload } from "source/app/service-providers/fsal";
import LogProvider from "source/app/service-providers/log";
import LongRunningTaskProvider from "source/app/service-providers/long-running-tasks";
import { unexpectedStoreWriteFailure } from "./store-write-failure";

/**
 * A booted FSAL whose only workspace is `root`. The file filters are off, so
 * the FSAL lists every path: the temporary file of an atomic write is a
 * listed path like any other file.
 */
export async function bootFsal(root: string): Promise<FSAL> {
  return await boot(root, true, () => {});
}

/**
 * A booted FSAL whose only workspace is `root`, with the file filters of the
 * configuration template on, as the application starts.
 */
export async function bootFilteredFsal(
  root: string,
  configure: (config: ConfigProvider) => void = () => {},
): Promise<FSAL> {
  return await boot(root, false, configure);
}

async function boot(
  root: string,
  showIgnored: boolean,
  configure: (config: ConfigProvider) => void,
): Promise<FSAL> {
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
  configure(config);

  const fsal = new FSAL(log, config, new LongRunningTaskProvider(log));
  await fsal.boot();
  return fsal;
}

/**
 * Resolves when the watcher of `fsal` reports a file in `root`. The watcher
 * reports nothing before its first scan ends, and `FSAL.boot` does not wait
 * for that scan, so a spec that changes a file one time (a removal) waits
 * for this first. The probe file is removed again.
 */
export async function untilWatching(fsal: FSAL, root: string): Promise<void> {
  const probe = path.join(root, "watcher-probe.md");
  let reported = false;
  const listener = (events: FSALEventPayload[]): void => {
    if (events.some((event) => "descriptor" in event && event.descriptor.path === probe)) {
      reported = true;
    }
  };
  fsal.on("fsal-events", listener);
  const deadline = Date.now() + 20_000;
  let writes = 0;
  while (!reported && Date.now() < deadline) {
    writes += 1;
    await writeFile(probe, `# Probe ${writes}\n`);
    await sleep(250);
  }
  fsal.off("fsal-events", listener);
  await rm(probe);
  assert.ok(reported, `the watcher of the FSAL must report ${probe}`);
}
