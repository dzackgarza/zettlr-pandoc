import type { ProjectNavigationItem } from '@dts/common/fsal'
import { resolvePath } from '@common/util/renderer-path-polyfill'
import { extractASTNodes, markdownToAST } from '@common/modules/markdown-utils'
import type { Heading } from '@common/modules/markdown-utils/markdown-ast'

export interface QuartoBookSection {
  title: string
  level: number
  line: number
}

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

export function extractQuartoBookSections (source: string): QuartoBookSection[] {
  const headings = extractASTNodes(markdownToAST(source), 'Heading') as Heading[]
  const sections = headings[0]?.level === 1 ? headings.slice(1) : headings

  return sections.map(heading => ({
    title: heading.content,
    level: heading.level,
    line: source.slice(0, heading.from).split('\n').length
  }))
}

export function buildQuartoBookOutline (
  rootPath: string,
  navigation: ProjectNavigationItem[],
  titleForPath: (filePath: string) => string
): QuartoBookOutline {
  let position = 0
  const chapter = (relativePath: string): QuartoBookChapter => {
    const filePath = resolvePath(rootPath, relativePath)
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
