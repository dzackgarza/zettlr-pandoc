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
import type ConfigProvider from "source/app/service-providers/config";
import FSAL from "source/app/service-providers/fsal";
import LogProvider from "source/app/service-providers/log";
import LongRunningTaskProvider from "source/app/service-providers/long-running-tasks";

/**
 * A booted FSAL whose only workspace is `root`. The file filters are off, so
 * the FSAL lists every path: the temporary file of an atomic write is a
 * listed path like any other file.
 */
export async function bootFsal(root: string): Promise<FSAL> {
  const log = new LogProvider();
  const shown = { showInFilemanager: true };
  const values = {
    app: { openFiles: [], openWorkspaces: [root] },
    fileManager: { ignoreRules: [], showIgnored: true, filters: { include: [] } },
    files: {
      images: shown,
      pdf: shown,
      msoffice: shown,
      openOffice: shown,
      dataFiles: shown,
      dotFiles: shown,
    },
    attachmentExtensions: [],
    zkn: { idRE: "(\\d{14})" },
    system: { deleteOnFail: false },
    watchdog: { activatePolling: false, stabilityThreshold: 1000 },
  };
  // The FSAL reads the whole configuration, and these values by their key.
  const byKey = new Map<string, boolean | number>([
    ["system.deleteOnFail", values.system.deleteOnFail],
    ["watchdog.activatePolling", values.watchdog.activatePolling],
    ["watchdog.stabilityThreshold", values.watchdog.stabilityThreshold],
  ]);
  const config = {
    get: (key?: string) => {
      if (key === undefined) {
        return values;
      }
      const value = byKey.get(key);
      assert.notEqual(value, undefined, `the FSAL read the configuration key ${key}`);
      return value;
    },
    on: (_event: "update", _listener: (which?: string) => void) => {},
    newVersionDetected: () => false,
  };

  const fsal = new FSAL(log, config as unknown as ConfigProvider, new LongRunningTaskProvider(log));
  await fsal.boot();
  return fsal;
}
