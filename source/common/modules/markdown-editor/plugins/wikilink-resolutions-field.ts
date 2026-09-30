/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Wikilink resolution state field
 * CVM-Role:        CodeMirror Extension
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     How the link provider resolved each wikilink target of the
 *                  document, and the callback that opens a wikilink. The
 *                  editor resolves nothing itself: MainEditor.vue asks the
 *                  link provider's `resolve-wikilinks` and puts the answer here.
 *
 * END HEADER
 */

import { Facet, StateEffect, StateField } from '@codemirror/state'
import type { WikilinkResolution } from '@common/util/wikilink-resolution'

/** Resolutions keyed by target, the text of a wikilink before `#` and `|`. */
export type WikilinkResolutions = Map<string, WikilinkResolution>

export const wikilinkResolutionsUpdate = StateEffect.define<WikilinkResolutions>()

/** Null until the first resolutions arrive; nothing renders while it is null. */
export const wikilinkResolutionsField = StateField.define<WikilinkResolutions|null>({
  create () {
    return null
  },
  update (value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(wikilinkResolutionsUpdate)) {
        return effect.value
      }
    }
    return value
  }
})

/** Opens the wikilink whose text before `|` is the argument. */
export const wikilinkOpener = Facet.define<(linkContents: string) => void, ((linkContents: string) => void)|undefined>({
  combine: values => values[0]
})
