import { resolvePath } from "@common/util/renderer-path-polyfill";
import type { ProjectNavigationItem } from "@dts/common/fsal";

export interface QuartoBookChapter {
  path: string;
  title: string;
  position: number;
}

/**
 * A row of the Book module. A part that a file names (`part-file`) is a
 * document of the book: it has the title and the position of that file.
 */
export type QuartoBookOutlineItem =
  | ({ kind: "chapter" } & QuartoBookChapter)
  | { kind: "part"; title: string; chapters: QuartoBookChapter[] }
  | ({ kind: "part-file"; chapters: QuartoBookChapter[] } & QuartoBookChapter);

export interface QuartoBookOutline {
  items: QuartoBookOutlineItem[];
  orderedPaths: string[];
}

export function buildQuartoBookOutline(
  rootPath: string,
  navigation: ProjectNavigationItem[],
  titleForPath: (filePath: string) => string,
): QuartoBookOutline {
  let position = 0;
  const chapter = (relativePath: string): QuartoBookChapter => {
    const filePath = resolvePath(rootPath, relativePath);
    position += 1;
    return { path: filePath, title: titleForPath(filePath), position };
  };

  const items: QuartoBookOutlineItem[] = navigation.map((item) => {
    if (item.kind === "chapter") {
      return { kind: "chapter", ...chapter(item.path) };
    }

    if (item.kind === "part") {
      return { kind: "part", title: item.title, chapters: item.chapters.map(chapter) };
    }

    // The file of the part comes before the chapters of the part.
    const partFile = chapter(item.path);
    return { kind: "part-file", ...partFile, chapters: item.chapters.map(chapter) };
  });

  return {
    items,
    orderedPaths: items.flatMap((item) => {
      if (item.kind === "chapter") {
        return [item.path];
      }
      const chapters = item.chapters.map((entry) => entry.path);
      return item.kind === "part" ? chapters : [item.path, ...chapters];
    }),
  };
}
