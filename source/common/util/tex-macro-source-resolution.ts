import picomatch from 'picomatch'
import {
  isAbsolutePath,
  pathDirname,
  resolvePath
} from './renderer-path-polyfill'

const TEX_MACRO_SOURCE_EXTENSIONS = [ '.tex', '.sty', '.cls' ] as const

export function isTexMacroSourcePath (filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return TEX_MACRO_SOURCE_EXTENSIONS.some(extension => lower.endsWith(extension))
}

function normalizeForGlob (filePath: string): string {
  return filePath.replaceAll('\\', '/')
}

function containsGlob (pattern: string): boolean {
  return /[*?[\]{}()!+@]/u.test(pattern)
}

/**
 * Resolves tex.macro_sources against paths already known to Zettlr's workspace
 * authority. A literal file path may be outside the workspace and is returned
 * directly; glob/directory expansion never enumerates the filesystem itself.
 */
export function resolveTexMacroSourcePaths (
  documentPath: string,
  patterns: readonly string[],
  workspacePaths: readonly string[]
): string[] {
  const parent = pathDirname(documentPath)
  const candidates = workspacePaths.filter(isTexMacroSourcePath)
  const resolved = new Set<string>()

  for (const rawPattern of patterns) {
    const pattern = rawPattern.trim()
    if (pattern === '') {
      continue
    }

    const absolutePattern = isAbsolutePath(pattern)
      ? pattern
      : resolvePath(parent, pattern)

    if (!containsGlob(pattern)) {
      if (isTexMacroSourcePath(absolutePattern)) {
        resolved.add(absolutePattern)
        continue
      }

      const directoryPrefix = normalizeForGlob(absolutePattern).replace(/\/+$/u, '') + '/'
      for (const candidate of candidates) {
        if (normalizeForGlob(candidate).startsWith(directoryPrefix)) {
          resolved.add(candidate)
        }
      }
      continue
    }

    const matcher = picomatch(normalizeForGlob(absolutePattern), { dot: true })
    for (const candidate of candidates) {
      if (matcher(normalizeForGlob(candidate))) {
        resolved.add(candidate)
      }
    }
  }

  return [...resolved].sort()
}
