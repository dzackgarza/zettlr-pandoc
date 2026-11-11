import isFile from "@common/util/is-file";
import type { ProjectNavigationItem } from "@dts/common/fsal";
import path from "path";
import YAML from "yaml";
import { z } from "zod";
import { resolveRealPath } from "./real-path";

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

export interface QuartoProject {
  title: string;
  files: string[];
  bibliographies: string[];
  navigation: ProjectNavigationItem[];
}

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
 * @return  {QuartoProject}                     The book, in real paths
 */
export function parseQuartoProject(manifestDirectory: string, source: string): QuartoProject {
  const parsed: unknown = YAML.parse(source);
  const manifest = manifestSchema.parse(parsed);
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
    title: manifest.book.title,
    files,
    bibliographies: bibliographyPaths.map(chapterFile),
    navigation,
  };
}
