import path from 'path'
import type { ProjectNavigationItem } from '@dts/common/fsal'

export interface QuartoBookChapter {
  path: string
  title: string
  position: number
}

export type QuartoBookOutlineItem =
  | ({ kind: 'chapter' } & QuartoBookChapter)
  | { kind: 'part', title: string, chapters: QuartoBookChapter[] }

export interface QuartoBookOutline {
  items: QuartoBookOutlineItem[]
  orderedPaths: string[]
}

export function buildQuartoBookOutline (
  rootPath: string,
  navigation: ProjectNavigationItem[],
  titleForPath: (filePath: string) => string
): QuartoBookOutline {
  let position = 0
  const chapter = (relativePath: string): QuartoBookChapter => {
    const filePath = path.resolve(rootPath, relativePath)
    position += 1
    return { path: filePath, title: titleForPath(filePath), position }
  }

  const items: QuartoBookOutlineItem[] = navigation.map(item => {
    if (item.kind === 'chapter') {
      return { kind: 'chapter', ...chapter(item.path) }
    }

    return {
      kind: 'part',
      title: item.title,
      chapters: item.chapters.map(chapter)
    }
  })

  return {
    items,
    orderedPaths: items.flatMap(item => item.kind === 'chapter'
      ? [ item.path ]
      : item.chapters.map(entry => entry.path))
  }
}
