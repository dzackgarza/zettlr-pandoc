import path from 'node:path'
import { promises as fs } from 'node:fs'
import { isMap, isScalar, isSeq, parseDocument, type Document, type Node, type YAMLSeq } from 'yaml'
import { resolveRealPath } from './real-path'

export type QuartoChapterPlacement =
  | { kind: 'book-end' }
  | { kind: 'part-end', partIndex: number }
  | { kind: 'before-chapter', chapterPath: string }
  | { kind: 'after-chapter', chapterPath: string }

export type QuartoBookEdit =
  | { kind: 'add-chapter', chapterPath: string, placement?: QuartoChapterPlacement }
  | { kind: 'move-chapter', chapterPath: string, placement: QuartoChapterPlacement }
  | { kind: 'add-part', title: string, chapterPath: string }

interface ChapterLocation {
  container: YAMLSeq<unknown>
  index: number
  node: unknown
}

function unixPath (value: string): string {
  return value.split(path.sep).join('/')
}

function projectRelative (rootPath: string, absolutePath: string): string {
  return unixPath(path.relative(resolveRealPath(rootPath), resolveRealPath(absolutePath)))
}

function absoluteChapterPath (rootPath: string, chapterPath: string): string {
  const root = resolveRealPath(rootPath)
  const absolute = resolveRealPath(path.resolve(root, chapterPath))
  const relative = path.relative(root, absolute)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Can't add ${chapterPath}: it is outside this Project`)
  }
  return absolute
}

function authoredPathFor (rootPath: string, manifestPath: string, chapterPath: string): string {
  const absolute = absoluteChapterPath(rootPath, chapterPath)
  const manifestDirectory = path.dirname(manifestPath)
  const rootRelative = projectRelative(rootPath, absolute)

  // A bound book may assemble the prose through directory symlinks beside the
  // manifest. Prefer that manifest-local route when it resolves to the same
  // real file; Quarto then sees a normal in-project chapter rather than a
  // `../` escape to the prose root.
  const manifestLocal = path.resolve(manifestDirectory, rootRelative)
  if (resolveRealPath(manifestLocal) === absolute) {
    return rootRelative
  }

  const relative = path.relative(manifestDirectory, absolute)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(
      `Can't add ${chapterPath}: Quarto cannot reach that file from this book`
    )
  }
  return unixPath(relative)
}

function scalarString (node: unknown): string|undefined {
  return isScalar(node) && typeof node.value === 'string' ? node.value : undefined
}

function chapterIdentity (rootPath: string, manifestPath: string, authoredPath: string): string {
  return projectRelative(rootPath, path.resolve(path.dirname(manifestPath), authoredPath))
}

function chaptersSequence (document: Document<Node>): YAMLSeq<unknown> {
  const chapters = document.getIn([ 'book', 'chapters' ], true)
  if (!isSeq(chapters)) {
    throw new Error('This Quarto book has no chapter list')
  }
  return chapters
}

function partChapters (node: unknown): YAMLSeq<unknown>|undefined {
  if (!isMap(node)) return undefined
  const part = node.get('part', true)
  if (scalarString(part) === undefined) return undefined
  const chapters = node.get('chapters', true)
  return isSeq(chapters) ? chapters : undefined
}

function findChapter (
  rootPath: string,
  manifestPath: string,
  chapters: YAMLSeq<unknown>,
  projectChapterPath: string
): ChapterLocation|undefined {
  for (let index = 0; index < chapters.items.length; index++) {
    const item = chapters.items[index]
    const authored = scalarString(item)
    if (authored !== undefined && chapterIdentity(rootPath, manifestPath, authored) === projectChapterPath) {
      return { container: chapters, index, node: item }
    }

    const nested = partChapters(item)
    if (nested === undefined) continue
    for (let nestedIndex = 0; nestedIndex < nested.items.length; nestedIndex++) {
      const chapterNode = nested.items[nestedIndex]
      const nestedAuthored = scalarString(chapterNode)
      if (
        nestedAuthored !== undefined &&
        chapterIdentity(rootPath, manifestPath, nestedAuthored) === projectChapterPath
      ) {
        return { container: nested, index: nestedIndex, node: chapterNode }
      }
    }
  }
  return undefined
}

function removeChapter (location: ChapterLocation): unknown {
  const [ node ] = location.container.items.splice(location.index, 1)
  if (node === undefined) {
    throw new Error('The chapter was removed while the book was being edited')
  }
  return node
}

function insertAtPlacement (
  rootPath: string,
  manifestPath: string,
  chapters: YAMLSeq<unknown>,
  node: unknown,
  placement: QuartoChapterPlacement
): void {
  if (placement.kind === 'book-end') {
    chapters.items.push(node)
    return
  }

  if (placement.kind === 'part-end') {
    const part = chapters.items[placement.partIndex]
    const nested = partChapters(part)
    if (nested === undefined) {
      throw new Error(`Book item ${placement.partIndex + 1} is not a part that can contain chapters`)
    }
    nested.items.push(node)
    return
  }

  const target = findChapter(rootPath, manifestPath, chapters, placement.chapterPath)
  if (target === undefined) {
    throw new Error(`Can't place the chapter next to ${placement.chapterPath} because that chapter is not in the book`)
  }
  target.container.items.splice(
    target.index + (placement.kind === 'after-chapter' ? 1 : 0),
    0,
    node
  )
}

/**
 * Applies one authoring edit to a Quarto book manifest while retaining the
 * parsed YAML document, including unrelated keys and comments. Chapter
 * identities are the Project-relative real paths used everywhere else in
 * Zettlr, not the possibly-symlinked strings authored beside the manifest.
 */
export function editQuartoBookSource (
  rootPath: string,
  manifestPath: string,
  source: string,
  edit: QuartoBookEdit
): string {
  const document = parseDocument(source)
  if (document.errors.length > 0) {
    throw new Error(`Can't edit the Quarto book: ${document.errors[0].message}`)
  }
  const chapters = chaptersSequence(document)

  if (edit.kind === 'add-chapter') {
    absoluteChapterPath(rootPath, edit.chapterPath)
    if (findChapter(rootPath, manifestPath, chapters, edit.chapterPath) !== undefined) {
      throw new Error(`${edit.chapterPath} is already in the book`)
    }
    const node = document.createNode(authoredPathFor(rootPath, manifestPath, edit.chapterPath))
    insertAtPlacement(rootPath, manifestPath, chapters, node, edit.placement ?? { kind: 'book-end' })
    return document.toString()
  }

  if (edit.kind === 'move-chapter') {
    const sourceLocation = findChapter(rootPath, manifestPath, chapters, edit.chapterPath)
    if (sourceLocation === undefined) {
      throw new Error(`Can't move ${edit.chapterPath}: it is not in the book`)
    }
    const node = removeChapter(sourceLocation)
    insertAtPlacement(rootPath, manifestPath, chapters, node, edit.placement)
    return document.toString()
  }

  const title = edit.title.trim()
  if (title === '') {
    throw new Error('A Quarto part needs a title')
  }
  absoluteChapterPath(rootPath, edit.chapterPath)

  const existing = findChapter(rootPath, manifestPath, chapters, edit.chapterPath)
  const chapterNode = existing === undefined
    ? document.createNode(authoredPathFor(rootPath, manifestPath, edit.chapterPath))
    : removeChapter(existing)
  const partNode = document.createNode({
    part: title,
    chapters: [ scalarString(chapterNode) ?? authoredPathFor(rootPath, manifestPath, edit.chapterPath) ]
  })
  // Keep the original Scalar node (and any chapter comment) when an existing
  // chapter is moved into the new part.
  if (existing !== undefined && isMap(partNode)) {
    const nested = partNode.get('chapters', true)
    if (isSeq(nested)) {
      nested.items[0] = chapterNode
    }
  }
  chapters.items.push(partNode)
  return document.toString()
}

/** Writes one structural edit back to the manifest. */
export async function editQuartoBookManifest (
  rootPath: string,
  manifestPath: string,
  edit: QuartoBookEdit
): Promise<void> {
  const source = await fs.readFile(manifestPath, 'utf8')
  const edited = editQuartoBookSource(rootPath, manifestPath, source, edit)
  await fs.writeFile(manifestPath, edited, 'utf8')
}
