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
  type Completion,
  type CompletionSource,
  type CompletionResult,
  autocompletion,
  CompletionContext,
  completeAnyWord,
} from '@codemirror/autocomplete'
import { type StateField } from '@codemirror/state'
import { codeBlocks } from './code-blocks'
import { atSymbols } from './at-symbols'
import { snippets } from './snippets'
import { files } from './files'
import { tags } from './tags'
import { headings } from './headings'
import { emojis } from './emojis'
import { texConstructionSource } from './tex-constructions'
import { texCommandSource } from './tex-commands'
import { proseDictionarySource } from './prose-dictionary'
import {
  phraseCompletionSource,
  phraseCompletionsField,
  phraseCompletionsUpdate
} from './phrases'
import {
  texCommandCompletionSource,
  texMacroSourcesUpdate
} from './tex'
import {
  completionOptionClass,
  renderCompletionIcon,
  renderCompletionSource,
  withDefaultCompletionInfo,
  withCompletionSource,
  type CompletionSourceName,
} from './completion-presentation'

export interface AutocompletePlugin {
  /** Source label shown in the aligned nvim-cmp-style rightmost column. */
  source?: CompletionSourceName
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
  applies: (ctx: CompletionContext) => number|false
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
  entries: (ctx: CompletionContext, query: string) => Completion[]
  fields?: Array<StateField<any>>
}

const forbiddenTokens = [
  'YAMLFrontmatter',
  'YAMLFrontmatterStart',
  'YAMLFrontmatterEnd'
]

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
export function autocompleteSourceFor (
  plugin: AutocompletePlugin,
  boost: number = 0
): CompletionSource {
  return function (ctx): CompletionResult|null {
    if (ctx.tokenBefore(forbiddenTokens) !== null) {
      return null
    }
    const from = plugin.applies(ctx)
    if (from === false) {
      return null
    }
    const query = ctx.state.doc.sliceString(from, ctx.pos).toLowerCase()
    return {
      from,
      options: plugin.entries(ctx, query).map(option => {
        const sourced = withCompletionSource(option, plugin.source)
        const enriched = withDefaultCompletionInfo(sourced, sourced.zettlrSource)
        return {
          ...enriched,
          boost: Math.max(-99, Math.min(99, (option.boost ?? 0) + boost))
        }
      })
    }
  }
}

/** CodeMirror's own cached current-buffer word source, labeled and de-prioritized. */
export const bufferWordSource: CompletionSource = ctx => {
  const result = completeAnyWord(ctx)
  if (result === null || result instanceof Promise) {
    return result
  }
  return {
    ...result,
    options: result.options.map(option => ({
      ...withCompletionSource(option, 'Buffer'),
      boost: (option.boost ?? 0) - 20
    }))
  }
}

// NOTE: Headings has to be checked before tags
export const AUTOCOMPLETE_PROVIDERS: AutocompletePlugin[] = [ codeBlocks, atSymbols, files, headings, tags, emojis, snippets ]
export const AUTOCOMPLETE_SOURCES: CompletionSource[] = [
  autocompleteSourceFor(codeBlocks, 40),
  autocompleteSourceFor(atSymbols, 40),
  autocompleteSourceFor(files, 40),
  autocompleteSourceFor(headings, 40),
  autocompleteSourceFor(tags, 30),
  autocompleteSourceFor(emojis, 10),
  autocompleteSourceFor(snippets, 25),
  texCommandCompletionSource,
  texConstructionSource,
  texCommandSource,
  phraseCompletionSource,
  proseDictionarySource,
  bufferWordSource,
]

export const autocomplete = [
  autocompletion({
    activateOnTyping: true, // Always show immediately
    activateOnTypingDelay: 25,
    selectOnOpen: true,
    closeOnBlur: true,
    maxRenderedOptions: 20,
    override: AUTOCOMPLETE_SOURCES,
    // Match the workstation's nvim-cmp presentation without replacing
    // CodeMirror's popup engine: use its native match spans and documented
    // content hooks to add a compact icon and aligned `[Source]` column.
    icons: false,
    optionClass: completionOptionClass,
    addToOptions: [
      { position: 20, render: renderCompletionIcon },
      { position: 90, render: renderCompletionSource }
    ],
    // Do not include the default keymap. Instead, we re-define it below to
    // avoid a specific decision by CodeMirror to remap the autocomplete toggle
    // on macOS to Alt+\ which, on an Italian keyboard layout, will fail to
    // produce backticks. (See issue #5517)
    defaultKeymap: false
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
  phraseCompletionsField
]

// Lastly, also re-export the effects which the main class (MarkdownEditor)
// requires in order to provide data for these fields.
export { citekeyUpdate } from './citations'
export { referencesUpdate } from './at-symbols'
export { filesUpdate } from './files'
export { tagsUpdate } from './tags'
export { snippetsUpdate } from './snippets'
export { phraseCompletionsUpdate, texMacroSourcesUpdate }
