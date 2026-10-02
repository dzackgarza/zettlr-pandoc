/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:    Link Provider IPC Contract
 * CVM-Role:    Types
 * Maintainer:  D. Zack Garza
 * License:     GNU GPL v3
 *
 * Description:     The IPC contract of the link provider, owned here beside
 *                  its handlers (the module file carries pre-existing lint
 *                  debt, so the contract lives adjacent).
 *
 * END HEADER
 */

import type { WikilinkResolution } from "@common/util/wikilink-resolution";

/** A wikilink target, and the document it resolves to when it names exactly one. */
export interface WikilinkEdge {
  target: string;
  path: string | undefined;
}

export type LinkProviderIPCContract = {
  "get-inbound-links": {
    request: { payload: { filePath: string } };
    response: { inbound: string[]; outbound: string[] };
  };
  "get-link-database": {
    request: { payload?: undefined };
    response: Record<string, WikilinkEdge[]>;
  };
  "get-link-targets": {
    request: { payload?: undefined };
    response: Record<string, string>;
  };
  /** How each target, the text of a wikilink before `#` and `|`, resolves from `sourcePath`. */
  "resolve-wikilinks": {
    request: { payload: { sourcePath: string; targets: string[] } };
    response: Record<string, WikilinkResolution>;
  };
};
