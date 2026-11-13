/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        loadDatabaseOnThread
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Reads one citation database on a thread of its own. The
 *                  parse of a BibLaTeX library of some thousand entries takes
 *                  seconds and gives no turn to the event loop, so it must
 *                  not run on the thread of the main process (#138). One load
 *                  owns one thread: the thread ends with the load, and a load
 *                  that its owner stops ends its thread. The record comes
 *                  as one transferred buffer, and the owner reads it one
 *                  entry in each turn of its event loop
 *                  (database-record-transfer.ts).
 *
 *                  The thread is a Node worker thread:
 *                  https://nodejs.org/api/worker_threads.html
 *
 * END HEADER
 */

import { Worker } from "worker_threads";
import type { LogDetails } from "../../log";
import type { DatabaseRecord } from "..";
import type { LoaderLog } from "./database-loader";
import { decodeRecord, type SentRecord } from "./database-record-transfer";

/** What the thread reads: `workerData` of the worker. */
export interface DatabaseLoadTask {
  databasePath: string;
  /** The directory of the parse cache. */
  cacheDir: string;
}

/** What the thread sends to its owner. The last message is `loaded` or `failed`. */
export type DatabaseLoadMessage =
  | { kind: "log"; level: keyof LoaderLog; message: string; details: LogDetails }
  | { kind: "loaded"; record: SentRecord }
  | { kind: "failed"; cause: Error };

/**
 * The record of a database, read by the thread program at `threadFile`.
 * Rejects with the cause of a failed read. When `stop` aborts while the
 * thread reads, the thread is ended and the promise rejects with the reason
 * of the abort, after the thread is gone. When `stop` aborts after the thread
 * sent its record, the promise rejects with that reason too.
 */
export async function loadDatabaseOnThread(
  threadFile: string,
  task: DatabaseLoadTask,
  log: LoaderLog,
  stop: AbortSignal,
): Promise<DatabaseRecord> {
  stop.throwIfAborted();
  return await new Promise<DatabaseRecord>((resolve, reject) => {
    const worker = new Worker(threadFile, { workerData: task });
    let ended = false;

    const end = (): void => {
      ended = true;
      stop.removeEventListener("abort", onStop);
    };
    const onStop = (): void => {
      end();
      worker.terminate().then(() => reject(stop.reason), reject);
    };
    stop.addEventListener("abort", onStop);

    worker.on("message", (message: DatabaseLoadMessage) => {
      if (ended) {
        return;
      }
      if (message.kind === "log") {
        log[message.level](message.message, message.details);
      } else if (message.kind === "loaded") {
        end();
        decodeRecord(message.record, stop).then(resolve, reject);
      } else {
        end();
        reject(message.cause);
      }
    });
    worker.on("error", (cause) => {
      if (!ended) {
        end();
        reject(cause);
      }
    });
    worker.on("exit", (code) => {
      if (!ended) {
        end();
        reject(
          new Error(
            `The thread that reads ${task.databasePath} ended with code ${code} and gave no result.`,
          ),
        );
      }
    });
  });
}
