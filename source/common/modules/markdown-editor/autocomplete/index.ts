/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Autocomplete
 * CVM-Role:        Extension
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This is the autocomplete entry file. It defines a helper
 *                  class to manage different types of autocompletes and bundles
 *                  everything together.
 *
 * END HEADER
 */

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { type StateField } from "@codemirror/state";
import { atSymbols } from "./at-symbols";
import { codeBlocks } from "./code-blocks";
import { files } from "./files";
import { headings } from "./headings";
import { snippets } from "./snippets";
import { tags } from "./tags";

export interface AutocompletePlugin {
  /**
   * This function is frequently called and should return true as soon as the
   * plugin detects a string that it can autocomplete.
   *
   * @param   {CompletionContext}  ctx  The current completion context.
   *
   * @return  {number|false}            If the function returns false, the
   *                                    autocompletion does not apply. Otherwise
   *                                    returns a number -> the start pos.
   */
  applies: (ctx: CompletionContext) => number | false;
  /**
   * This function is called while an autocompletion is active. It is provided
   * the current query the user has typed and should return a filtered list of
   * all autocompletion entries that match that query. NOTE that the query can
   * be an empty string, in which case all entries are expected to be returned.
   *
   * @param   {CompletionContext}  ctx    The current completion context.
   * @param   {string}             query  The current query.
   *
   * @return  {Completion[]}              The list of available completions
   */
  entries: (ctx: CompletionContext, query: string) => Completion[];
  fields?: Array<StateField<any>>;
}

const forbiddenTokens = [
  "YAMLFrontmatter",
  "YAMLFrontmatterStart",
  "YAMLFrontmatterEnd",
  "MathEquation",
];

/**
 * Builds the completion source over an ordered provider list: the shared
 * forbidden-token gate followed by the first-match dispatch. Production uses
 * exactly one instance (over AUTOCOMPLETE_PROVIDERS below); the factory is
 * exported so tests exercise THIS dispatch loop rather than replicating it
 * (issue #5, C9).
 *
 * @param   {AutocompletePlugin[]}  providers  The ordered provider list
 *
 * @return  {CompletionSource}                 The dispatching source
 */
export function createAutocompleteSource(providers: AutocompletePlugin[]): CompletionSource {
  return function (ctx): CompletionResult | null {
    // This function is called for every keystroke and shall determine whether
    // to actually start the autocomplete.

    // With this function we check whether we are currently within "forbidden"
    // tokens (i.e. codeblocks, YAML stuff, etc.)
    if (ctx.tokenBefore(forbiddenTokens) !== null) {
      return null;
    }

    let plugin: AutocompletePlugin | undefined;
    let startpos = ctx.pos;

    for (const p of providers) {
      const res = p.applies(ctx);
      if (res !== false) {
        plugin = p;
        startpos = res;
        break;
      }
    }

    if (plugin !== undefined) {
      const initialOptions = plugin.entries(
        ctx,
        ctx.state.doc.sliceString(startpos, ctx.pos).toLowerCase(),
      );
      return {
        from: startpos,
        options: initialOptions,
        filter: false,
        update: (current, from, to, ctx) => {
          const query = ctx.state.doc.sliceString(from, to).toLowerCase();
          current.options = plugin!.entries(ctx, query);
          return current;
        },
      };
    }

    // Return null to indicate that autocomplete does not apply.
    return null;
  };
}

// NOTE: Headings has to be checked before tags
export const AUTOCOMPLETE_PROVIDERS: AutocompletePlugin[] = [
  codeBlocks,
  atSymbols,
  files,
  headings,
  tags,
  snippets,
];

const autocompleteSource: CompletionSource = createAutocompleteSource(AUTOCOMPLETE_PROVIDERS);

export const autocomplete = [
  autocompletion({
    activateOnTyping: true, // Always show immediately
    selectOnOpen: true, // But never pre-select anything
    closeOnBlur: true,
    maxRenderedOptions: 20,
    override: [autocompleteSource],
    // Do not include the default keymap. Instead, we re-define it below to
    // avoid a specific decision by CodeMirror to remap the autocomplete toggle
    // on macOS to Alt+\ which, on an Italian keyboard layout, will fail to
    // produce backticks. (See issue #5517)
    defaultKeymap: false,
  }),
  // Make sure any configuration fields will be inserted into the state so that
  // the plugins can look them up and function correctly. These fields are not
  // required by the main class (MarkdownEditor), hence we do not have to re-
  // export them here.
  codeBlocks.fields ?? [],
  // atSymbols carries both the citation field and the references field, so
  // each is registered exactly once through this single entry.
  atSymbols.fields ?? [],
  files.fields ?? [],
  tags.fields ?? [],
  snippets.fields ?? [],
];

export { referencesUpdate } from "./at-symbols";
// Lastly, also re-export the effects which the main class (MarkdownEditor)
// requires in order to provide data for these fields.
export { citekeyUpdate } from "./citations";
export { filesUpdate } from "./files";
export { snippetsUpdate } from "./snippets";
export { tagsUpdate } from "./tags";
