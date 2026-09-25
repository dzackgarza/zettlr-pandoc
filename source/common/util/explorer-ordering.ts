import type {
  AnyDescriptor,
  DirDescriptor,
  FileNameDisplay,
  MDFileDescriptor,
  ProjectFileFilter,
  SortMethod
} from '@dts/common/fsal'
import { isInsideRoot } from './renderer-path-polyfill'

export interface ExplorerSortDefaults {
  sortingType: 'natural'|'ascii'
  sortFoldersFirst: boolean
  fileNameDisplay: FileNameDisplay
  appLang: string
  fileMetaTime: 'modtime'|'creationtime'
}

export interface ProjectMembership {
  rootPath: string
  manifestKind: 'zettlr'|'quarto'
  status: 'included'|'omitted'
  /** One-based position in ProjectSettings.files when included. */
  position?: number
}

type SortKey = SortMethod extends `${infer K}-${'up'|'down'}` ? K : never

/** Project-relative paths are always stored with Unix separators. */
export function projectRelativePath (filePath: string, rootPath: string): string {
  if (filePath === rootPath) {
    return ''
  }
  return filePath.slice(rootPath.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
}

/** The most specific visible Project root containing a path. */
export function projectRootForPath (
  filePath: string,
  roots: readonly AnyDescriptor[]
): DirDescriptor|undefined {
  return roots
    .filter((root): root is DirDescriptor => {
      return root.type === 'directory' &&
        root.settings.project !== null &&
        (filePath === root.path || isInsideRoot(filePath, root.path))
    })
    .sort((a, b) => b.path.length - a.path.length)[0]
}

/** How one file relates to the Project root that contains it. */
export function projectMembershipForPath (
  filePath: string,
  roots: readonly AnyDescriptor[]
): ProjectMembership|undefined {
  const root = projectRootForPath(filePath, roots)
  const project = root?.settings.project
  if (root === undefined || project === null || project === undefined) {
    return undefined
  }

  const index = project.files.indexOf(projectRelativePath(filePath, root.path))
  return {
    rootPath: root.path,
    manifestKind: project.manifest.kind,
    status: index >= 0 ? 'included' : 'omitted',
    ...(index >= 0 ? { position: index + 1 } : {})
  }
}

export function effectiveExplorerDisplay (
  directory: DirDescriptor,
  fallback: FileNameDisplay
): FileNameDisplay {
  return directory.settings.explorer.displayName === 'inherit'
    ? fallback
    : directory.settings.explorer.displayName
}

/**
 * A Project-root display override is a view-level choice and applies through
 * nested chapter directories. When the root inherits the global display,
 * ordinary per-directory overrides continue to work.
 */
export function effectiveExplorerDisplayForDirectory (
  directory: DirDescriptor,
  roots: readonly AnyDescriptor[],
  fallback: FileNameDisplay
): FileNameDisplay {
  const projectRoot = projectRootForPath(directory.path, roots)
  if (projectRoot !== undefined && projectRoot.settings.explorer.displayName !== 'inherit') {
    return projectRoot.settings.explorer.displayName
  }
  return effectiveExplorerDisplay(directory, fallback)
}

export function effectiveFoldersFirst (directory: DirDescriptor, fallback: boolean): boolean {
  return directory.settings.explorer.foldersFirst ?? fallback
}

/**
 * Project filters hide only files. Directories remain visible so filtering a
 * book never destroys the navigation route to matching descendants.
 */
export function matchesProjectFilter (
  descriptor: AnyDescriptor,
  filter: ProjectFileFilter,
  roots: readonly AnyDescriptor[]
): boolean {
  if (filter === 'all' || descriptor.type === 'directory') {
    return true
  }
  const membership = projectMembershipForPath(descriptor.path, roots)
  return membership?.status === filter
}

function splitSortMethod (method: SortMethod): { key: SortKey, direction: 'up'|'down' } {
  const split = method.lastIndexOf('-')
  return {
    key: method.slice(0, split) as SortKey,
    direction: method.slice(split + 1) as 'up'|'down'
  }
}

function documentDisplayValue (descriptor: AnyDescriptor, display: FileNameDisplay): string {
  if (descriptor.type !== 'file') {
    return descriptor.name
  }

  const hasTitle = typeof descriptor.frontmatter?.title === 'string' && descriptor.frontmatter.title.trim() !== ''
  const hasHeading = descriptor.firstHeading != null && descriptor.firstHeading.trim() !== ''

  if (display.includes('title') && hasTitle) {
    return descriptor.frontmatter.title
  }
  if (display.includes('heading') && hasHeading) {
    return descriptor.firstHeading!
  }
  return descriptor.name
}

function scalarMetadataValue (descriptor: AnyDescriptor, key: string): string|number|boolean|undefined {
  if (descriptor.type !== 'file' || descriptor.frontmatter == null) {
    return undefined
  }
  const value: unknown = descriptor.frontmatter[key]
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : undefined
}

function compareStrings (a: string, b: string, defaults: ExplorerSortDefaults): number {
  if (defaults.sortingType === 'ascii') {
    const aa = a.toLowerCase()
    const bb = b.toLowerCase()
    return aa < bb ? -1 : aa > bb ? 1 : 0
  }
  return new Intl.Collator([ defaults.appLang, 'en' ], { numeric: true }).compare(a, b)
}

function compareScalars (
  a: string|number|boolean|undefined,
  b: string|number|boolean|undefined,
  defaults: ExplorerSortDefaults
): number {
  // Missing metadata is always last, independent of direction. This makes a
  // partially annotated directory useful instead of moving unannotated files
  // to the top whenever the direction is reversed.
  if (a === undefined && b === undefined) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  return compareStrings(String(a), String(b), defaults)
}

function bookRank (descriptor: AnyDescriptor, projectRoot: DirDescriptor|undefined): number|undefined {
  const project = projectRoot?.settings.project
  if (projectRoot === undefined || project === null || project === undefined) {
    return undefined
  }

  const relative = projectRelativePath(descriptor.path, projectRoot.path)
  if (descriptor.type !== 'directory') {
    const index = project.files.indexOf(relative)
    return index < 0 ? undefined : index
  }

  const prefix = relative === '' ? '' : `${relative}/`
  let minimum: number|undefined
  for (let index = 0; index < project.files.length; index++) {
    if (prefix === '' || project.files[index].startsWith(prefix)) {
      minimum = minimum === undefined ? index : Math.min(minimum, index)
    }
  }
  return minimum
}

function compareByKey (
  a: AnyDescriptor,
  b: AnyDescriptor,
  key: SortKey,
  sortOwner: DirDescriptor,
  displayOwner: DirDescriptor,
  defaults: ExplorerSortDefaults,
  projectRoot: DirDescriptor|undefined
): number {
  const display = effectiveExplorerDisplay(displayOwner, defaults.fileNameDisplay)

  switch (key) {
    case 'name':
      return compareStrings(documentDisplayValue(a, display), documentDisplayValue(b, display), defaults)
    case 'filename':
      return compareStrings(a.name, b.name, defaults)
    case 'title':
      return compareStrings(
        a.type === 'file' && typeof a.frontmatter?.title === 'string' ? a.frontmatter.title : a.name,
        b.type === 'file' && typeof b.frontmatter?.title === 'string' ? b.frontmatter.title : b.name,
        defaults
      )
    case 'heading':
      return compareStrings(
        a.type === 'file' && a.firstHeading != null ? a.firstHeading : a.name,
        b.type === 'file' && b.firstHeading != null ? b.firstHeading : b.name,
        defaults
      )
    case 'time': {
      // Preserve the historical `time-up` contract: "up" means newest first.
      const field = defaults.fileMetaTime
      return b[field] - a[field]
    }
    case 'modtime':
      return a.modtime - b.modtime
    case 'creationtime':
      return a.creationtime - b.creationtime
    case 'frontmatter':
      return compareScalars(
        scalarMetadataValue(a, sortOwner.settings.explorer.sortMetadataKey),
        scalarMetadataValue(b, sortOwner.settings.explorer.sortMetadataKey),
        defaults
      )
    case 'book': {
      const aa = bookRank(a, projectRoot)
      const bb = bookRank(b, projectRoot)
      if (aa === undefined && bb === undefined) {
        return compareStrings(a.name, b.name, defaults)
      }
      if (aa === undefined) return 1
      if (bb === undefined) return -1
      return aa - bb
    }
  }
}

/**
 * Sorts the direct children of one directory according to that directory's
 * persisted Explorer settings. A Book sort is semantic and therefore mixes
 * files and directories by manifest rank; other sorts obey the folders-first
 * preference (or sort all entries together when it is disabled).
 */
export function sortExplorerChildren (
  directory: DirDescriptor,
  children: readonly AnyDescriptor[],
  defaults: ExplorerSortDefaults,
  roots: readonly AnyDescriptor[]
): AnyDescriptor[] {
  const projectRoot = projectRootForPath(directory.path, roots)
  // The two legacy methods are historically per-directory. Explicit modern
  // sort keys chosen on a Project root are Explorer view modes and therefore
  // carry through all nested chapter directories.
  const rootMethod = projectRoot === undefined ? undefined : splitSortMethod(projectRoot.settings.sorting)
  const sortOwner = projectRoot !== undefined && rootMethod !== undefined && ![ 'name', 'time' ].includes(rootMethod.key)
    ? projectRoot
    : directory
  const { key, direction } = splitSortMethod(sortOwner.settings.sorting)
  const displayOwner = projectRoot !== undefined && projectRoot.settings.explorer.displayName !== 'inherit'
    ? projectRoot
    : directory
  const groupingOwner = projectRoot !== undefined && projectRoot.settings.explorer.foldersFirst !== null
    ? projectRoot
    : directory
  const projectFilter = projectRoot !== undefined && projectRoot.settings.explorer.projectFilter !== 'all'
    ? projectRoot.settings.explorer.projectFilter
    : directory.settings.explorer.projectFilter
  const sign = direction === 'up' ? 1 : -1
  const compare = (a: AnyDescriptor, b: AnyDescriptor): number => {
    const primary = compareByKey(a, b, key, sortOwner, displayOwner, defaults, projectRoot)
    if (primary !== 0) {
      // Missing metadata/book ranks are already deliberately pushed last. Do
      // not reverse that missing-value decision.
      if (key === 'frontmatter') {
        const av = scalarMetadataValue(a, sortOwner.settings.explorer.sortMetadataKey)
        const bv = scalarMetadataValue(b, sortOwner.settings.explorer.sortMetadataKey)
        if (av === undefined || bv === undefined) return primary
      }
      if (key === 'book') {
        const ar = bookRank(a, projectRoot)
        const br = bookRank(b, projectRoot)
        if (ar === undefined || br === undefined) return primary
      }
      // Legacy time-up is already descending in compareByKey.
      return primary * (key === 'time' ? (direction === 'up' ? 1 : -1) : sign)
    }
    return compareStrings(a.name, b.name, defaults)
  }

  const visible = children.filter(child => {
    return matchesProjectFilter(child, projectFilter, roots)
  })

  if (key === 'book' || !effectiveFoldersFirst(groupingOwner, defaults.sortFoldersFirst)) {
    return [...visible].sort(compare)
  }

  const directories = visible.filter((child): child is DirDescriptor => child.type === 'directory')
  const files = visible.filter(child => child.type !== 'directory')
  return [ ...directories.sort(compare), ...files.sort(compare) ]
}

/** Convenience predicate for UI that offers Book-only controls. */
export function hasProjectForPath (filePath: string, roots: readonly AnyDescriptor[]): boolean {
  return projectRootForPath(filePath, roots) !== undefined
}

/** Convenience narrowing for callers that need Markdown-only omitted choices. */
export function isMarkdownDescriptor (descriptor: AnyDescriptor): descriptor is MDFileDescriptor {
  return descriptor.type === 'file'
}
