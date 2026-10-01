import path from 'path'
import { promises as fs } from 'fs'
import type { AnyDescriptor } from '@dts/common/fsal'
import { ignorePath } from 'source/common/util/ignore-path'
import type { IgnoreFilter } from 'source/common/util/ignore-rules'

interface DirectoryReadLogger {
  error: (message: string, error?: unknown) => void
}

/** What a listing leaves out beside the built-in ignored names. */
export interface ListingRules {
  ignoreDotFiles: boolean
  ignoreFilter: IgnoreFilter
}

interface DirectoryChild {
  path: string
  isDirectory: boolean
}

/** A path that enters or leaves the listing when the ignore rules change. */
export interface VisibilityChange extends DirectoryChild {
  visible: boolean
}

/**
 * The files and folders of a directory that the ignore rules then judge: no
 * symbolic link, no built-in ignored name, no dot file when asked.
 */
async function candidateChildren (directoryPath: string, ignoreDotFiles: boolean): Promise<DirectoryChild[]> {
  const children = await fs.readdir(directoryPath, { withFileTypes: true })
  return children
    .filter(dirent => !ignorePath(dirent.name, ignoreDotFiles) && (dirent.isFile() || dirent.isDirectory()))
    .map(dirent => ({ path: path.join(directoryPath, dirent.name), isDirectory: dirent.isDirectory() }))
}

async function listedChildren (directoryPath: string, rules: ListingRules): Promise<DirectoryChild[]> {
  const children = await candidateChildren(directoryPath, rules.ignoreDotFiles)
  return children.filter(child => !rules.ignoreFilter.hides(child.path, child.isDirectory))
}

export async function readDirectoryFromDisk (
  absPath: string,
  rules: ListingRules,
  isDeadWorkspace: boolean,
  getDescriptor: (absPath: string) => Promise<AnyDescriptor>,
  logger: DirectoryReadLogger
): Promise<AnyDescriptor[]> {
  if (isDeadWorkspace) {
    throw new Error(`[FSAL] Cannot read path ${absPath}: Not a directory!`)
  }

  let isDirectory: boolean
  try {
    isDirectory = (await fs.lstat(absPath)).isDirectory()
  } catch (err: unknown) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined
    if (code === 'ENOENT') {
      return []
    }
    throw new Error(`[FSAL] Cannot read path ${absPath}: Not a directory!`)
  }

  if (!isDirectory) {
    throw new Error(`[FSAL] Cannot read path ${absPath}: Not a directory!`)
  }

  try {
    const children = await listedChildren(absPath, rules)

    const results = await Promise.allSettled(
      children.map(async child => await getDescriptor(child.path)
        .catch(err => logger.error(`[FSAL] Error while reading directory ${absPath}: Could not read child ${path.relative(absPath, child.path)}`, err)))
    )

    return results
      .filter((result): result is PromiseFulfilledResult<AnyDescriptor> => result.status === 'fulfilled' && result.value !== undefined)
      .map(result => result.value)
  } catch (err: unknown) {
    if (err instanceof Error) {
      logger.error(`[FSAL] Could not read directory: ${absPath}`, err)
    }

    return []
  }
}

/**
 * Lists a directory and everything below it that the app lists: the directory
 * itself, then each listed file and folder. A directory that cannot be read
 * contributes nothing.
 */
export async function readDirectoryRecursivelyFromDisk (
  directoryPath: string,
  rules: ListingRules,
  logger: DirectoryReadLogger
): Promise<string[]> {
  try {
    const children = await listedChildren(directoryPath, rules)
    const contents = await Promise.all(children.map(async child => {
      return child.isDirectory ? await readDirectoryRecursivelyFromDisk(child.path, rules, logger) : [child.path]
    }))
    return [ directoryPath, ...contents.flat() ]
  } catch (err: unknown) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined
    if (code === 'EACCES' || code === 'EPERM') {
      logger.error(`[FSAL] Could not read directory ${directoryPath}: Could not read/access the directory (code: ${code})`)
    } else if (err instanceof Error) {
      logger.error(`[FSAL] Could not read directory: ${directoryPath}`, err)
    }
    return []
  }
}

/**
 * Reports the paths below a workspace root that the listing gains or loses
 * when the ignore filter changes from `before` to `after`. The order is the
 * one a watcher gives for the same change on disk: a folder that becomes
 * visible comes before its content, a folder that becomes hidden after it.
 *
 * The walk stops at each path in `otherRoots`: another open workspace lists
 * that folder and its content whatever this workspace's rules say.
 */
export async function visibilityChanges (
  directoryPath: string,
  ignoreDotFiles: boolean,
  otherRoots: ReadonlySet<string>,
  before: IgnoreFilter,
  after: IgnoreFilter,
  logger: DirectoryReadLogger
): Promise<VisibilityChange[]> {
  let children: DirectoryChild[]
  try {
    children = await candidateChildren(directoryPath, ignoreDotFiles)
  } catch (err: unknown) {
    logger.error(`[FSAL] Could not read directory: ${directoryPath}`, err)
    return []
  }

  const changes: VisibilityChange[] = []
  for (const child of children) {
    if (otherRoots.has(child.path)) {
      continue
    }

    const wasVisible = !before.hides(child.path, child.isDirectory)
    const isVisible = !after.hides(child.path, child.isDirectory)
    if (!wasVisible && !isVisible) {
      continue
    }

    const below = child.isDirectory
      ? await visibilityChanges(child.path, ignoreDotFiles, otherRoots, before, after, logger)
      : []
    if (wasVisible === isVisible) {
      changes.push(...below)
    } else if (isVisible) {
      changes.push({ ...child, visible: true }, ...below)
    } else {
      changes.push(...below, { ...child, visible: false })
    }
  }
  return changes
}
