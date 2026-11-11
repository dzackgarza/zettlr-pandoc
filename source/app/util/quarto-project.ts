import isFile from "@common/util/is-file";
import type { ProjectNavigationItem, YamlValue } from "@dts/common/fsal";
import path from "path";
import YAML from "yaml";
import { z } from "zod";
import { resolveRealPath } from "./real-path";
import { schemaIssueSentence } from "./schema-issues";

const chapterPathSchema = z.string().min(1);

const partSchema = z
  .object({
    part: z.string().min(1),
    chapters: z.array(chapterPathSchema).optional(),
  })
  .passthrough();

const manifestSchema = z
  .object({
    project: z.object({ type: z.literal("book") }).passthrough(),
    book: z
      .object({
        title: z.string().min(1),
        chapters: z.array(z.union([chapterPathSchema, partSchema])).min(1),
      })
      .passthrough(),
    bibliography: z.union([chapterPathSchema, z.array(chapterPathSchema).min(1)]).optional(),
  })
  .passthrough();

/** The part of a manifest that says whether its project is a book. */
const bookProjectSchema = z.object({ project: z.object({ type: z.literal("book") }) });

export interface QuartoProject {
  title: string;
  files: string[];
  bibliographies: string[];
  navigation: ProjectNavigationItem[];
}

/**
 * What a manifest says to Zettlr. A manifest whose `project.type` is not
 * `book` (a website, a manuscript, a project without a type) is a manifest of
 * Quarto that describes no book. A manifest that is not YAML, and the
 * manifest of a book without the fields that Zettlr reads, cannot be used.
 */
export type QuartoManifestReading =
  | { kind: "book"; project: QuartoProject }
  | { kind: "not-a-book" }
  | { kind: "unusable"; message: string };

/**
 * The file that the `part` value of a book part names, or undefined when the
 * value is the title of the part. Quarto decides the same way: the value is a
 * file when a file is at that path of the project, and text otherwise
 * (`normalizeSidebarItem`, quarto-cli `src/project/project-config.ts`).
 *
 * @param   {string}  manifestDirectory  The directory holding _quarto.yml
 * @param   {string}  part               The `part` value
 *
 * @return  {string|undefined}           The real path of the file
 */
export function quartoPartFile(manifestDirectory: string, part: string): string | undefined {
  const file = resolveRealPath(path.resolve(manifestDirectory, part));
  return isFile(file) ? file : undefined;
}

/**
 * Parses the Quarto book fields that Zettlr owns at the authoring boundary.
 * Quarto remains the manifest, render, and numbering authority.
 *
 * Every path the manifest names is relative to the manifest's own directory,
 * which need not be the workspace the chapters live in: a book assembled from
 * symlinks reaches its chapters through that directory. So each path comes
 * back as the real file it names, which is the identity the rest of the
 * application knows a chapter by.
 *
 * @param   {string}         manifestDirectory  The directory holding _quarto.yml
 * @param   {string}         source             The manifest's contents
 *
 * @return  {QuartoManifestReading}             The book, in real paths, or
 *                                              why the manifest gives none
 */
export function readQuartoManifest(
  manifestDirectory: string,
  source: string,
): QuartoManifestReading {
  const document = YAML.parseDocument(source);
  if (document.errors.length > 0) {
    return {
      kind: "unusable",
      message: document.errors.map((error) => error.message).join("; "),
    };
  }
  const content: YamlValue = document.toJS();
  if (!bookProjectSchema.safeParse(content).success) {
    return { kind: "not-a-book" };
  }
  const parsed = manifestSchema.safeParse(content);
  if (!parsed.success) {
    return {
      kind: "unusable",
      message: schemaIssueSentence(parsed.error),
    };
  }
  const manifest = parsed.data;
  const chapterFile = (relativePath: string): string => {
    return resolveRealPath(path.resolve(manifestDirectory, relativePath));
  };
  const navigation: ProjectNavigationItem[] = manifest.book.chapters.map((item) => {
    if (typeof item === "string") {
      return { kind: "chapter", path: chapterFile(item) };
    }

    // Quarto accepts a part without the `chapters` key: a part of no chapters.
    const chapters = item.chapters === undefined ? [] : item.chapters.map(chapterFile);
    const partFile = quartoPartFile(manifestDirectory, item.part);
    return partFile === undefined
      ? { kind: "part", title: item.part, chapters }
      : { kind: "part-file", path: partFile, chapters };
  });
  const files = navigation.flatMap((item) => {
    if (item.kind === "chapter") {
      return [item.path];
    }
    return item.kind === "part" ? item.chapters : [item.path, ...item.chapters];
  });
  const bibliography = manifest.bibliography;
  const bibliographyPaths =
    bibliography === undefined
      ? []
      : typeof bibliography === "string"
        ? [bibliography]
        : bibliography;

  return {
    kind: "book",
    project: {
      title: manifest.book.title,
      files,
      bibliographies: bibliographyPaths.map(chapterFile),
      navigation,
    },
  };
}

/**
 * The book of a manifest. Throws when the manifest gives no book.
 *
 * @param   {string}         manifestDirectory  The directory holding _quarto.yml
 * @param   {string}         source             The manifest's contents
 *
 * @return  {QuartoProject}                     The book, in real paths
 */
export function parseQuartoProject(manifestDirectory: string, source: string): QuartoProject {
  const reading = readQuartoManifest(manifestDirectory, source);
  if (reading.kind === "book") {
    return reading.project;
  }
  throw new Error(
    reading.kind === "not-a-book"
      ? "The manifest is not the manifest of a Quarto book: project.type is not book."
      : reading.message,
  );
}
