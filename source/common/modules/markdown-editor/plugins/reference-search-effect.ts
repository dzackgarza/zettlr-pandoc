/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Reference search effect
 * CVM-Role:        CodeMirror Extension
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The workspace reference search signal of the editor
 *                  (issue #1 Phase 3b). A count badge dispatches the
 *                  StateEffect defined here; the MarkdownEditor update
 *                  listener re-emits it as a 'reference-search' event,
 *                  which MainEditor.vue relays up the component tree until
 *                  App.vue mounts the command launcher's
 *                  ReferenceSearchView.
 *
 * END HEADER
 */

import { StateEffect } from "@codemirror/state";
import { type Command } from "@codemirror/view";

/**
 * The intent carried by a reference search request: null is the definition
 * search of the command launcher (the window command
 * `open-command-launcher`); a keyed request (dispatched by a definition's
 * `N references` count badge, issue #1 Phase 4) asks the overlay to present
 * the workspace citing locations of exactly that definition key. The
 * request names ONLY the key: the citing occurrences themselves come from
 * the reference provider's merged snapshot fetched at open time — the
 * single owner of that fact (issues #53, #46) — never from a
 * renderer-captured copy travelling with the click.
 */
export type ReferenceSearchRequest = null | {
  key: string;
};

/**
 * Signals that the user requested the workspace reference search overlay.
 */
export const openReferenceSearchEffect = StateEffect.define<ReferenceSearchRequest>();
