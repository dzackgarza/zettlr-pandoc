/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Workspace wikilink resolution
 * CVM-Role:        Utility
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Resolves a `[[target]]` wikilink to one workspace document
 *                  by durable keys, after Obsidian's link model
 *                  (https://help.obsidian.md/links): a link names a document,
 *                  not a location, so moving a file does not break it.
 *
 * END HEADER
 */

import path from 'path'
import { hasMarkdownExt } from './file-extention-checks'

/** What a document is known by. */
export interface WikilinkDocument {
  /** Absolute path of the document. */
  path: string
  /** The workspace root that contains the document. */
  root: string
  /** The Zettelkasten ID, or '' when the document has none. */
  id: string
  /** The YAML `title`. */
  title: string|undefined
  /** The YAML `aliases`. */
  aliases: string[]
}

export type WikilinkResolution =
  | {
    status: 'resolved'
    path: string
    /** The written form: the shortest unique path suffix of `path`. */
    canonical: string
    /** The target named a path relative to the linking document. */
    relative: boolean
  }
  | { status: 'ambiguous', candidates: string[] }
  | { status: 'missing' }

/**
 * Splits the text before a wikilink's `|` label into the document target and
 * the `#heading` fragment.
 */
export function splitWikilinkTarget (raw: string): { target: string, fragment: string|undefined } {
  const hash = raw.indexOf('#')
  if (hash < 0) {
    return { target: raw.trim(), fragment: undefined }
  }
  return { target: raw.slice(0, hash).trim(), fragment: raw.slice(hash + 1).trim() }
}

/** Every `[[…]]` target in `text`, before its `#` fragment and `|` label. */
export function wikilinkTargetsIn (text: string): string[] {
  const targets = new Set<string>()
  for (const match of text.matchAll(/\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]/g)) {
    const { target } = splitWikilinkTarget(match[1])
    if (target !== '') {
      targets.add(target)
    }
  }
  return [...targets]
}

function isRelativeTarget (target: string): boolean {
  return target.startsWith('./') || target.startsWith('../') || path.isAbsolute(target)
}

function withoutMarkdownExt (filePath: string): string {
  return hasMarkdownExt(filePath) ? filePath.slice(0, -path.extname(filePath).length) : filePath
}

function normalizedKey (target: string): string {
  return withoutMarkdownExt(target.split(path.sep).join('/')).toLowerCase()
}

function addTo (map: Map<string, string[]>, key: string, documentPath: string): void {
  const entries = map.get(key)
  if (entries === undefined) {
    map.set(key, [documentPath])
  } else if (!entries.includes(documentPath)) {
    entries.push(documentPath)
  }
}

/**
 * The workspace's wikilink keys. A target resolves in tiers, and the first
 * tier with a match decides: the Zettelkasten ID, then a path suffix
 * (`note`, `dir/note`, the workspace-relative path), then a YAML alias, then
 * the YAML title. Matching ignores case and the Markdown extension. Two
 * matches in the deciding tier make the link ambiguous; a link never
 * silently picks one of them.
 */
export class WikilinkIndex {
  private readonly tiers: Array<Map<string, string[]>>
  private readonly byPath = new Map<string, string>()
  private readonly canonicalForms = new Map<string, string>()

  constructor (documents: WikilinkDocument[]) {
    const ids = new Map<string, string[]>()
    const suffixes = new Map<string, string[]>()
    const aliases = new Map<string, string[]>()
    const titles = new Map<string, string[]>()
    for (const document of documents) {
      this.byPath.set(withoutMarkdownExt(document.path), document.path)
      if (document.id !== '') {
        addTo(ids, document.id.toLowerCase(), document.path)
      }
      const segments = normalizedKey(path.relative(document.root, document.path)).split('/')
      for (let start = segments.length - 1; start >= 0; start--) {
        addTo(suffixes, segments.slice(start).join('/'), document.path)
      }
      for (const alias of document.aliases) {
        addTo(aliases, alias.toLowerCase(), document.path)
      }
      if (document.title !== undefined) {
        addTo(titles, document.title.toLowerCase(), document.path)
      }
    }
    this.tiers = [ ids, suffixes, aliases, titles ]
    for (const document of documents) {
      this.canonicalForms.set(document.path, this.shortestUniqueSuffix(document))
    }
  }

  /**
   * Resolves `target`, the part of a wikilink before `#` and `|`, written in
   * the document at `sourcePath`.
   */
  resolve (target: string, sourcePath: string): WikilinkResolution {
    if (isRelativeTarget(target)) {
      const absolute = path.resolve(path.dirname(sourcePath), target)
      const documentPath = this.byPath.get(withoutMarkdownExt(absolute))
      if (documentPath === undefined) {
        return { status: 'missing' }
      }
      return { status: 'resolved', path: documentPath, canonical: this.canonical(documentPath), relative: true }
    }
    const matches = this.match(normalizedKey(target))
    if (matches.length === 0) {
      return { status: 'missing' }
    }
    if (matches.length > 1) {
      return { status: 'ambiguous', candidates: [...matches].sort() }
    }
    return { status: 'resolved', path: matches[0], canonical: this.canonical(matches[0]), relative: false }
  }

  /** The written form of a link to `documentPath`. */
  canonical (documentPath: string): string {
    const form = this.canonicalForms.get(documentPath)
    if (form === undefined) {
      throw new Error(`No workspace document at ${documentPath}`)
    }
    return form
  }

  has (documentPath: string): boolean {
    return this.canonicalForms.has(documentPath)
  }

  private match (key: string): string[] {
    for (const tier of this.tiers) {
      const matches = tier.get(key)
      if (matches !== undefined) {
        return matches
      }
    }
    return []
  }

  /**
   * The shortest path suffix that resolves to `document` alone, in the file's
   * own spelling. When even the workspace-relative path is shared (the same
   * path in two workspaces), that path is the form, and links written with
   * it are reported as ambiguous.
   */
  private shortestUniqueSuffix (document: WikilinkDocument): string {
    const segments = withoutMarkdownExt(path.relative(document.root, document.path)).split(path.sep)
    for (let start = segments.length - 1; start >= 0; start--) {
      const suffix = segments.slice(start).join('/')
      const matches = this.match(suffix.toLowerCase())
      if (matches.length === 1 && matches[0] === document.path) {
        return suffix
      }
    }
    return segments.join('/')
  }
}
