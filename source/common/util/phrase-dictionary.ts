/** Plain-text completion dictionaries. Each non-comment line is one literal insertion. */
export interface PhraseDictionaryEntry {
  text: string
  source: string
}

export function parsePhraseDictionary (contents: string, source: string): PhraseDictionaryEntry[] {
  const entries = new Map<string, PhraseDictionaryEntry>()
  for (const [index, line] of contents.split(/\r\n?|\n/).entries()) {
    const text = line.trim()
    if (text === '' || text.startsWith('#')) {continue}
    if (/[\u0000-\u001f\u007f]/u.test(text)) {
      throw new Error(`${source}:${index + 1}: use spaces, not control characters, inside a completion phrase.`)
    }
    // Preserve authored spelling and punctuation. Only canonically equivalent
    // Unicode strings are duplicates; case-distinct entries remain distinct.
    const key = text.normalize('NFC')
    if (!entries.has(key)) {entries.set(key, { text, source })}
  }
  return [...entries.values()]
}
