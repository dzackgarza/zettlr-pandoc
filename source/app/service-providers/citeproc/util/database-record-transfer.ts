/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        encodeRecord, decodeRecord
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The form in which the record of a citation database goes
 *                  from the thread that read it to the owner of that thread.
 *
 *                  A record that goes through `postMessage` as one object is
 *                  made again on the thread of the owner in one step, and the
 *                  time of that step follows the size of the library: 108 ms
 *                  for 1500 entries in a process with a large heap (#138).
 *                  The thread therefore serializes each entry on its own into
 *                  one buffer and transfers the buffer, which costs the owner
 *                  nothing. The owner reads one entry in each turn of its
 *                  event loop.
 *
 *                  The serialization is that of the V8 API of Node:
 *                  https://nodejs.org/api/v8.html#serialization-api
 *                  A transferred buffer is not copied:
 *                  https://nodejs.org/api/worker_threads.html#portpostmessagevalue-transferlist
 *
 *                  This module imports nothing of Electron: the thread
 *                  program imports it.
 *
 * END HEADER
 */

import { setImmediate as nextTurn } from "timers/promises";
import { DefaultDeserializer, DefaultSerializer } from "v8";
import type { DatabaseRecord } from "..";

/** One entry of a record: an item of `cslData` or a value of `bibtexAttachments`. */
type RecordEntry =
  | { of: "cslData"; id: string; value: DatabaseRecord["cslData"][string] }
  | { of: "bibtexAttachments"; id: string; value: DatabaseRecord["bibtexAttachments"][string] };

/** A record as the thread sends it. */
export interface SentRecord {
  path: DatabaseRecord["path"];
  type: DatabaseRecord["type"];
  /** The serialized entries, one after the other. The sender transfers `entries.buffer`. */
  entries: Uint8Array<ArrayBuffer>;
  /** The number of entries in `entries`. */
  count: number;
}

/**
 * The form of a record that its owner can read one entry at a time. The
 * caller transfers `entries.buffer` with the message.
 */
export function encodeRecord(record: DatabaseRecord): SentRecord {
  const entries: RecordEntry[] = [
    ...Object.entries(record.cslData).map(
      ([id, value]): RecordEntry => ({ of: "cslData", id, value }),
    ),
    ...Object.entries(record.bibtexAttachments).map(
      ([id, value]): RecordEntry => ({ of: "bibtexAttachments", id, value }),
    ),
  ];
  const writer = new DefaultSerializer();
  writer.writeHeader();
  for (const entry of entries) {
    writer.writeValue(entry);
  }
  // The bytes go into a buffer that holds nothing else, so its transfer
  // takes nothing from another view.
  const written = writer.releaseBuffer();
  const bytes = new Uint8Array(new ArrayBuffer(written.byteLength));
  bytes.set(written);
  return {
    path: record.path,
    type: record.type,
    entries: bytes,
    count: entries.length,
  };
}

/**
 * The record that a thread sent. Reads one entry in each turn of the event
 * loop, so the time that the thread of the caller is busy without a turn is
 * the time of one entry. Rejects with the reason of `stop` when it aborts.
 */
export async function decodeRecord(sent: SentRecord, stop: AbortSignal): Promise<DatabaseRecord> {
  const record: DatabaseRecord = {
    path: sent.path,
    type: sent.type,
    cslData: {},
    bibtexAttachments: {},
  };
  const reader = new DefaultDeserializer(sent.entries);
  reader.readHeader();
  for (let read = 0; read < sent.count; read++) {
    stop.throwIfAborted();
    const entry: RecordEntry = reader.readValue();
    if (entry.of === "cslData") {
      record.cslData[entry.id] = entry.value;
    } else {
      record.bibtexAttachments[entry.id] = entry.value;
    }
    await nextTurn();
  }
  stop.throwIfAborted();
  return record;
}
