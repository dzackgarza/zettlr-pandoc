/**
 * Deterministic editor-local numbering for workspace references.
 *
 * These numbers are presentation aids only. Export filters and writers retain
 * full ownership of exported numbering, which may differ. The editor number
 * has three components:
 *
 *   project-or-standalone-group.document.family-local-ordinal
 *
 * Project roots are ordered by path. Files inside a Project use the authored
 * ProjectSettings.files order; omitted files follow in path order. Documents
 * outside every Project share one final standalone group and are path ordered.
 * Within a document, each reference family has its own counter in source
 * order. Thus the second figure in the first document of the first Project is
 * `Figure 1.1.2`, while the first lemma there is `Lemma 1.1.1`.
 *
 * Renderer-safe: no Node built-ins, filesystem access, or CodeMirror imports.
 */

import type {
  ProjectRootSpec,
  ReferenceDefinition,
  ReferenceFamily,
  Resolution
} from '../../types/common/references'

function normalizedPath (value: string): string {
  const slashes = value.replace(/\\/g, '/').replace(/\/+$/g, '')
  return slashes === '' ? '/' : slashes
}

function pathInsideRoot (documentPath: string, rootPath: string): boolean {
  const document = normalizedPath(documentPath)
  const root = normalizedPath(rootPath)
  return document === root || document.startsWith(root === '/' ? '/' : `${root}/`)
}

function pathInRoot (rootPath: string, relativePath: string): string {
  const root = normalizedPath(rootPath)
  const relative = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  return root === '/' ? `/${relative}` : `${root}/${relative}`
}

function resolvedDefinitions (resolutions: ReadonlyMap<string, Resolution>): ReferenceDefinition[] {
  const definitions: ReferenceDefinition[] = []
  for (const resolution of resolutions.values()) {
    if (resolution.status === 'resolved') {
      definitions.push(resolution.definition)
    }
  }
  return definitions
}

interface NumberingGroup {
  index: number
  root: ProjectRootSpec | undefined
  definitions: ReferenceDefinition[]
}

function projectGroups (
  definitions: readonly ReferenceDefinition[],
  projectRoots: readonly ProjectRootSpec[]
): NumberingGroup[] {
  const roots = [...projectRoots].sort((a, b) => normalizedPath(a.rootPath).localeCompare(normalizedPath(b.rootPath)))
  const groups: NumberingGroup[] = roots.map((root, index) => ({
    index: index + 1,
    root,
    definitions: []
  }))
  const standalone: NumberingGroup = {
    index: roots.length + 1,
    root: undefined,
    definitions: []
  }

  for (const definition of definitions) {
    const group = groups.find(candidate => candidate.root !== undefined && pathInsideRoot(definition.documentPath, candidate.root.rootPath))
    if (group === undefined) {
      standalone.definitions.push(definition)
    } else {
      group.definitions.push(definition)
    }
  }

  if (standalone.definitions.length > 0 || groups.length === 0) {
    groups.push(standalone)
  }
  return groups
}

function documentOrdinals (group: NumberingGroup): Map<string, number> {
  const documentPaths = [...new Set(group.definitions.map(definition => normalizedPath(definition.documentPath)))]
  const ordinals = new Map<string, number>()

  if (group.root === undefined) {
    documentPaths.sort((a, b) => a.localeCompare(b))
    documentPaths.forEach((documentPath, index) => ordinals.set(documentPath, index + 1))
    return ordinals
  }

  const root = group.root
  const listedPaths = root.files.map(file => normalizedPath(pathInRoot(root.rootPath, file)))
  listedPaths.forEach((documentPath, index) => {
    if (documentPaths.includes(documentPath)) {
      ordinals.set(documentPath, index + 1)
    }
  })

  const omitted = documentPaths
    .filter(documentPath => !ordinals.has(documentPath))
    .sort((a, b) => a.localeCompare(b))
  omitted.forEach((documentPath, index) => ordinals.set(documentPath, root.files.length + index + 1))
  return ordinals
}

/**
 * Computes the display number of every uniquely resolved reference key.
 * Duplicate and missing keys have no number because they have no unique
 * target to number.
 */
export function referenceDisplayNumbers (
  resolutions: ReadonlyMap<string, Resolution>,
  projectRoots: readonly ProjectRootSpec[] = []
): Map<string, string> {
  const numbers = new Map<string, string>()
  const definitions = resolvedDefinitions(resolutions)

  for (const group of projectGroups(definitions, projectRoots)) {
    const docOrdinals = documentOrdinals(group)
    const definitionsByDocument = new Map<string, ReferenceDefinition[]>()
    for (const definition of group.definitions) {
      const documentPath = normalizedPath(definition.documentPath)
      const existing = definitionsByDocument.get(documentPath)
      if (existing === undefined) {
        definitionsByDocument.set(documentPath, [definition])
      } else {
        existing.push(definition)
      }
    }

    for (const [documentPath, documentDefinitions] of definitionsByDocument) {
      documentDefinitions.sort((a, b) => a.range.from - b.range.from || a.key.localeCompare(b.key))
      const familyCounts = new Map<ReferenceFamily, number>()
      for (const definition of documentDefinitions) {
      const priorCount = familyCounts.get(definition.family)
      const ordinal = (priorCount === undefined ? 0 : priorCount) + 1
        familyCounts.set(definition.family, ordinal)
        const documentOrdinal = docOrdinals.get(documentPath)
        if (documentOrdinal === undefined) {
          throw new Error(`Reference numbering has no document ordinal for ${documentPath}`)
        }
        numbers.set(definition.key, `${group.index}.${documentOrdinal}.${ordinal}`)
      }
    }
  }

  return numbers
}
