/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        serializeChangeSet
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The single place a ChangeSet becomes a wire value. Both the
 *                  document authority (main) and the collab plugin (renderer)
 *                  push serialized change sets, and `ChangeSet.toJSON()` is
 *                  typed `any` upstream — so without this the only value that
 *                  must satisfy SerializedChanges was produced unchecked, and a
 *                  live ChangeSet reached the update history once already. The
 *                  cost of that was a RangeError in the renderer's pull loop,
 *                  far from the push that caused it.
 *
 * END HEADER
 */

import type { ChangeSet } from "@codemirror/state";
import type { SerializedChanges } from "@dts/common/documents";

/**
 * A ChangeSet's JSON form is an array whose entries are either a number (a
 * retained length) or an array of numbers and strings (a replacement).
 */
function isSerializedChanges(value: unknown): value is SerializedChanges {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every((section) => {
    if (typeof section === "number") {
      return true;
    }
    if (!Array.isArray(section)) {
      return false;
    }
    return section.every((part) => typeof part === "number" || typeof part === "string");
  });
}

/**
 * Converts a ChangeSet into the form that crosses IPC, proving the result is
 * what the wire type claims.
 *
 * Throws rather than returning a fallback: an unrecognized shape means the
 * installed @codemirror/state changed its serialization, and every consumer of
 * the update history would then be reading a format `ChangeSet.fromJSON` cannot
 * parse. There is no safe value to substitute.
 *
 * @param   {ChangeSet}          changes  The change set to serialize
 *
 * @return  {SerializedChanges}           The validated JSON form
 */
export default function serializeChangeSet(changes: ChangeSet): SerializedChanges {
  const json: unknown = changes.toJSON();
  if (!isSerializedChanges(json)) {
    throw new Error(
      "ChangeSet.toJSON() returned a shape SerializedChanges does not describe. " +
        "The @codemirror/state serialization format has changed; update " +
        "SerializedChanges and isSerializedChanges together. Received: " +
        JSON.stringify(json),
    );
  }
  return json;
}
