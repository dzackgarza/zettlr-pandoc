/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The thread program of a citation database load
 * CVM-Role:        Utility
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The program of the worker thread that loadDatabaseOnThread
 *                  starts. It reads the database that `workerData` names and
 *                  sends the record, or the cause of the failure, to its
 *                  owner. This module imports nothing of Electron: a worker
 *                  thread has no Electron modules.
 *
 * END HEADER
 */

import { parentPort, workerData } from "worker_threads";
import type { LogDetails } from "../../log";
import { type LoaderLog, loadDatabase } from "./database-loader";
import type { DatabaseLoadMessage, DatabaseLoadTask } from "./load-database-on-thread";

if (parentPort === null) {
  throw new Error("The database loader runs as a worker thread only.");
}
const owner = parentPort;

const task: DatabaseLoadTask = workerData;

function send(message: DatabaseLoadMessage): void {
  owner.postMessage(message);
}

function logCall(level: keyof LoaderLog): (message: string, details?: LogDetails) => void {
  return (message, details = null) => send({ kind: "log", level, message, details });
}

const log: LoaderLog = {
  info: logCall("info"),
  warning: logCall("warning"),
  error: logCall("error"),
};

loadDatabase(task.databasePath, log, task.cacheDir).then(
  (record) => send({ kind: "loaded", record }),
  (cause: unknown) =>
    send({ kind: "failed", cause: cause instanceof Error ? cause : new Error(String(cause)) }),
);
