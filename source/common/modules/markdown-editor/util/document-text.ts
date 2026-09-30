/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        documentText
 * CVM-Role:        Utility Function
 * License:         GNU GPL v3
 *
 * Description:     The text of a document as one string. The Markdown AST
 *                  builder reads node text from such a string, and the editor
 *                  document makes a new one on each request. This function
 *                  makes one string for each document version.
 *
 * END HEADER
 */

import type { EditorState, Text } from '@codemirror/state'

const texts = new WeakMap<Text, string>()

export function documentText (state: EditorState): string {
  let text = texts.get(state.doc)
  if (text === undefined) {
    text = state.sliceDoc()
    texts.set(state.doc, text)
  }
  return text
}
