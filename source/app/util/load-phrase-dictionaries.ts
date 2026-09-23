import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { FSWatcher } from 'chokidar'
import { parsePhraseDictionary, type PhraseDictionaryEntry } from '../../common/util/phrase-dictionary'

/** Watch the same top-level files the loader reads, including paths under .pandoc. */
export function createPhraseDictionaryWatcher (): FSWatcher {
  return new FSWatcher({ depth: 0, persistent: true, ignoreInitial: true })
}

/**
 * Read the explicitly supplied dictionary directory. No generated index, hidden
 * default path, or persistent cache: calling again observes external edits,
 * additions and deletions. The owning app must surface rejected reads.
 */
export async function loadPhraseDictionaries (directory: string): Promise<PhraseDictionaryEntry[]> {
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter(file => (file.isFile() || file.isSymbolicLink()) && file.name.toLowerCase().endsWith('.txt'))
    .map(file => file.name)
    .sort()
  const entries = new Map<string, PhraseDictionaryEntry>()
  const decoder = new TextDecoder('utf-8', { fatal: true })

  for (const name of files) {
    const filename = path.join(directory, name)
    let contents: string
    try {
      contents = decoder.decode(await readFile(filename))
    } catch (cause) {
      throw new Error(`Cannot read UTF-8 phrase dictionary ${filename}.`, { cause })
    }
    for (const entry of parsePhraseDictionary(contents, filename)) {
      const key = entry.text.normalize('NFC')
      if (!entries.has(key)) {entries.set(key, entry)}
    }
  }
  return [...entries.values()]
}
