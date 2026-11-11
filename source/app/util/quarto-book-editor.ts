import { promises as fs } from "node:fs";
import path from "node:path";
import {
  type Document,
  isMap,
  isScalar,
  isSeq,
  type Node,
  parseDocument,
  type YAMLMap,
  YAMLSeq,
} from "yaml";
import { writeTextFile } from "../service-providers/fsal/util/write-text-file";
import { quartoPartFile } from "./quarto-project";
import { resolveRealPath } from "./real-path";

export type QuartoChapterPlacement =
  | { kind: "book-end" }
  | { kind: "part-end"; partIndex: number }
  | { kind: "before-chapter"; chapterPath: string }
  | { kind: "after-chapter"; chapterPath: string };

export type QuartoBookEdit =
  | { kind: "add-chapter"; chapterPath: string; placement: QuartoChapterPlacement }
  | { kind: "move-chapter"; chapterPath: string; placement: QuartoChapterPlacement }
  | { kind: "add-part"; title: string; chapterPath: string };

interface ChapterLocation {
  container: YAMLSeq<unknown>;
  index: number;
  node: unknown;
}

function unixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function projectRelative(rootPath: string, absolutePath: string): string {
  return unixPath(path.relative(resolveRealPath(rootPath), resolveRealPath(absolutePath)));
}

function absoluteChapterPath(rootPath: string, chapterPath: string): string {
  const root = resolveRealPath(rootPath);
  const absolute = resolveRealPath(path.resolve(root, chapterPath));
  const relative = path.relative(root, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Can't add ${chapterPath}: it is outside this Project`);
  }
  return absolute;
}

function authoredPathFor(rootPath: string, manifestPath: string, chapterPath: string): string {
  const absolute = absoluteChapterPath(rootPath, chapterPath);
  const manifestDirectory = path.dirname(manifestPath);
  const rootRelative = projectRelative(rootPath, absolute);

  // A bound book may assemble the prose through directory symlinks beside the
  // manifest. Prefer that manifest-local route when it resolves to the same
  // real file; Quarto then sees a normal in-project chapter rather than a
  // `../` escape to the prose root.
  const manifestLocal = path.resolve(manifestDirectory, rootRelative);
  if (resolveRealPath(manifestLocal) === absolute) {
    return rootRelative;
  }

  const relative = path.relative(manifestDirectory, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Can't add ${chapterPath}: Quarto cannot reach that file from this book`);
  }
  return unixPath(relative);
}

function scalarString(node: unknown): string | undefined {
  return isScalar(node) && typeof node.value === "string" ? node.value : undefined;
}

function chapterIdentity(rootPath: string, manifestPath: string, authoredPath: string): string {
  return projectRelative(rootPath, path.resolve(path.dirname(manifestPath), authoredPath));
}

function chaptersSequence(document: Document<Node>): YAMLSeq<unknown> {
  const chapters = document.getIn(["book", "chapters"], true);
  if (!isSeq(chapters)) {
    throw new Error("This Quarto book has no chapter list");
  }
  return chapters;
}

/** The book item as a part: a map with a `part` value. */
function partNode(node: unknown): YAMLMap<unknown, unknown> | undefined {
  return isMap(node) && scalarString(node.get("part", true)) !== undefined ? node : undefined;
}

function partChapters(node: unknown): YAMLSeq<unknown> | undefined {
  const chapters = partNode(node)?.get("chapters", true);
  return isSeq(chapters) ? chapters : undefined;
}

/** The chapter list of a part. A part with no list gets an empty one. */
function ensurePartChapters(part: YAMLMap<unknown, unknown>): YAMLSeq<unknown> {
  const existing = partChapters(part);
  if (existing !== undefined) return existing;
  const chapters = new YAMLSeq<unknown>();
  part.set("chapters", chapters);
  return chapters;
}

interface PartFileLocation {
  index: number;
  part: YAMLMap<unknown, unknown>;
}

/**
 * The part whose `part` value names the given document. That document is in
 * the book, but in no chapter list.
 */
function findPartFile(
  rootPath: string,
  manifestPath: string,
  chapters: YAMLSeq<unknown>,
  projectPath: string,
): PartFileLocation | undefined {
  const manifestDirectory = path.dirname(manifestPath);
  for (let index = 0; index < chapters.items.length; index++) {
    const part = partNode(chapters.items[index]);
    const value = scalarString(part?.get("part", true));
    if (part === undefined || value === undefined) continue;
    const file = quartoPartFile(manifestDirectory, value);
    if (file !== undefined && projectRelative(rootPath, file) === projectPath) {
      return { index, part };
    }
  }
  return undefined;
}

/** Throws when the document is in the book: a chapter, or the file of a part. */
function assertNotInBook(
  rootPath: string,
  manifestPath: string,
  chapters: YAMLSeq<unknown>,
  projectPath: string,
): void {
  if (
    findChapter(rootPath, manifestPath, chapters, projectPath) !== undefined ||
    findPartFile(rootPath, manifestPath, chapters, projectPath) !== undefined
  ) {
    throw new Error(`${projectPath} is already in the book`);
  }
}

function findChapter(
  rootPath: string,
  manifestPath: string,
  chapters: YAMLSeq<unknown>,
  projectChapterPath: string,
): ChapterLocation | undefined {
  for (let index = 0; index < chapters.items.length; index++) {
    const item = chapters.items[index];
    const authored = scalarString(item);
    if (
      authored !== undefined &&
      chapterIdentity(rootPath, manifestPath, authored) === projectChapterPath
    ) {
      return { container: chapters, index, node: item };
    }

    const nested = partChapters(item);
    if (nested === undefined) continue;
    for (let nestedIndex = 0; nestedIndex < nested.items.length; nestedIndex++) {
      const chapterNode = nested.items[nestedIndex];
      const nestedAuthored = scalarString(chapterNode);
      if (
        nestedAuthored !== undefined &&
        chapterIdentity(rootPath, manifestPath, nestedAuthored) === projectChapterPath
      ) {
        return { container: nested, index: nestedIndex, node: chapterNode };
      }
    }
  }
  return undefined;
}

function removeChapter(location: ChapterLocation): unknown {
  const [node] = location.container.items.splice(location.index, 1);
  if (node === undefined) {
    throw new Error("The chapter was removed while the book was being edited");
  }
  return node;
}

function insertAtPlacement(
  rootPath: string,
  manifestPath: string,
  chapters: YAMLSeq<unknown>,
  node: unknown,
  placement: QuartoChapterPlacement,
): void {
  if (placement.kind === "book-end") {
    chapters.items.push(node);
    return;
  }

  if (placement.kind === "part-end") {
    const part = partNode(chapters.items[placement.partIndex]);
    if (part === undefined) {
      throw new Error(
        `Book item ${placement.partIndex + 1} is not a part that can contain chapters`,
      );
    }
    ensurePartChapters(part).items.push(node);
    return;
  }

  // The file of a part comes before the chapters of the part: the place after
  // it is the start of the part, and the place before it is before the part.
  const partFile = findPartFile(rootPath, manifestPath, chapters, placement.chapterPath);
  if (partFile !== undefined) {
    if (placement.kind === "after-chapter") {
      ensurePartChapters(partFile.part).items.unshift(node);
    } else {
      chapters.items.splice(partFile.index, 0, node);
    }
    return;
  }

  const target = findChapter(rootPath, manifestPath, chapters, placement.chapterPath);
  if (target === undefined) {
    throw new Error(
      `Can't place the chapter next to ${placement.chapterPath} because that chapter is not in the book`,
    );
  }
  target.container.items.splice(
    target.index + (placement.kind === "after-chapter" ? 1 : 0),
    0,
    node,
  );
}

/**
 * Applies one authoring edit to a Quarto book manifest while retaining the
 * parsed YAML document, including unrelated keys and comments. Chapter
 * identities are the Project-relative real paths used everywhere else in
 * Zettlr, not the possibly-symlinked strings authored beside the manifest.
 */
export function editQuartoBookSource(
  rootPath: string,
  manifestPath: string,
  source: string,
  edit: QuartoBookEdit,
): string {
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    throw new Error(`Can't edit the Quarto book: ${document.errors[0].message}`);
  }
  const chapters = chaptersSequence(document);

  if (edit.kind === "add-chapter") {
    absoluteChapterPath(rootPath, edit.chapterPath);
    assertNotInBook(rootPath, manifestPath, chapters, edit.chapterPath);
    const node = document.createNode(authoredPathFor(rootPath, manifestPath, edit.chapterPath));
    insertAtPlacement(rootPath, manifestPath, chapters, node, edit.placement);
    return document.toString();
  }

  if (edit.kind === "move-chapter") {
    const sourceLocation = findChapter(rootPath, manifestPath, chapters, edit.chapterPath);
    if (sourceLocation === undefined) {
      throw new Error(`Can't move ${edit.chapterPath}: it is not in the book`);
    }
    const node = removeChapter(sourceLocation);
    insertAtPlacement(rootPath, manifestPath, chapters, node, edit.placement);
    return document.toString();
  }

  const title = edit.title.trim();
  if (title === "") {
    throw new Error("A Quarto part needs a title");
  }
  absoluteChapterPath(rootPath, edit.chapterPath);
  if (findPartFile(rootPath, manifestPath, chapters, edit.chapterPath) !== undefined) {
    throw new Error(`${edit.chapterPath} is the file of a part of the book`);
  }

  const existing = findChapter(rootPath, manifestPath, chapters, edit.chapterPath);
  const chapterNode =
    existing === undefined
      ? document.createNode(authoredPathFor(rootPath, manifestPath, edit.chapterPath))
      : removeChapter(existing);
  const newPart = document.createNode({
    part: title,
    chapters: [
      scalarString(chapterNode) ?? authoredPathFor(rootPath, manifestPath, edit.chapterPath),
    ],
  });
  // Keep the original Scalar node (and any chapter comment) when an existing
  // chapter is moved into the new part.
  if (existing !== undefined && isMap(newPart)) {
    const nested = newPart.get("chapters", true);
    if (isSeq(nested)) {
      nested.items[0] = chapterNode;
    }
  }
  chapters.items.push(newPart);
  return document.toString();
}

/** Writes one structural edit back to the manifest. */
export async function editQuartoBookManifest(
  rootPath: string,
  manifestPath: string,
  edit: QuartoBookEdit,
): Promise<void> {
  const source = await fs.readFile(manifestPath, "utf8");
  const edited = editQuartoBookSource(rootPath, manifestPath, source, edit);
  await writeTextFile(manifestPath, edited);
}
