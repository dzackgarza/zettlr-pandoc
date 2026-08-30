import path from 'path'
import YAML from 'yaml'
import { z } from 'zod'
import type { ProjectNavigationItem } from '@dts/common/fsal'

const chapterPathSchema = z.string().min(1)

const partSchema = z.object({
  part: z.string().min(1),
  chapters: z.array(chapterPathSchema).min(1)
}).passthrough()

const manifestSchema = z.object({
  project: z.object({ type: z.literal('book') }).passthrough(),
  book: z.object({
    title: z.string().min(1),
    chapters: z.array(z.union([ chapterPathSchema, partSchema ])).min(1)
  }).passthrough(),
  bibliography: z.union([ chapterPathSchema, z.array(chapterPathSchema).min(1) ]).optional()
}).passthrough()

export interface QuartoProject {
  title: string
  files: string[]
  bibliographies: string[]
  navigation: ProjectNavigationItem[]
}

/**
 * Parses the Quarto book fields that Zettlr owns at the authoring boundary.
 * Quarto remains the manifest, render, and numbering authority.
 */
export function parseQuartoProject (rootPath: string, source: string): QuartoProject {
  const parsed: unknown = YAML.parse(source)
  const manifest = manifestSchema.parse(parsed)
  const navigation: ProjectNavigationItem[] = manifest.book.chapters.map(item => {
    if (typeof item === 'string') {
      return { kind: 'chapter', path: item }
    }

    return { kind: 'part', title: item.part, chapters: item.chapters }
  })
  const files = navigation.flatMap(item => item.kind === 'chapter' ? [ item.path ] : item.chapters)
  const bibliography = manifest.bibliography
  const bibliographyPaths = bibliography === undefined
    ? []
    : typeof bibliography === 'string' ? [ bibliography ] : bibliography

  return {
    title: manifest.book.title,
    files,
    bibliographies: bibliographyPaths.map(filename => path.resolve(rootPath, filename)),
    navigation
  }
}
