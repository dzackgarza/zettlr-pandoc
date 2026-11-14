/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:    Tag Provider IPC Contract
 * CVM-Role:    Types
 * Maintainer:  D. Zack Garza
 * License:     GNU GPL v3
 *
 * Description:     The IPC contract of the tag provider, owned here beside its
 *                  handlers (the module file carries pre-existing lint debt,
 *                  so the contract lives adjacent).
 *
 * END HEADER
 */

import type { ColoredTag, TagRecord } from "./index";

/** A `tag-provider` message to the windows: the tags or the coloured tags changed. */
export type TagProviderBroadcast =
  | [command: "tags-updated", tags: TagRecord[]]
  | [command: "colored-tags-updated", coloredTags: ColoredTag[]];

export type TagProviderIPCContract = {
  "get-all-tags": {
    request: { payload?: undefined };
    response: TagRecord[];
  };
  "get-colored-tags": {
    request: { payload?: undefined };
    response: ColoredTag[];
  };
  "set-colored-tags": {
    request: { payload: ColoredTag[] };
    response: undefined;
  };
};
