/**
 * Resolves the filesystem targets used by the command launcher's desktop
 * actions. The input deliberately contains only path metadata so this stays a
 * pure, renderer-independent policy that can be tested without Vue or Pinia.
 */

import { pathDirname } from '@common/util/renderer-path-polyfill'

export interface DesktopPathDescriptor {
  path: string
  dir: string
  type: 'file'|'directory'|'code'|'other'
}

export interface DesktopCommandContext {
  focusPath?: string
  activeFilePath?: string
  selectedDirectory: string|null
  descriptors: ReadonlyMap<string, DesktopPathDescriptor>
  roots: readonly DesktopPathDescriptor[]
}

/** The file to open externally: a focused file first, then the active editor file. */
export function resolveExternalFile (context: DesktopCommandContext): string|undefined {
  if (context.focusPath !== undefined) {
    const focused = context.descriptors.get(context.focusPath)
    if (focused !== undefined && focused.type !== 'directory') {
      return focused.path
    }
  }
  return context.activeFilePath
}

/**
 * The directory meant by "here": the focused item's directory (or the
 * focused directory itself), then the active editor file's directory, then
 * the Explorer's selected directory, then an unambiguous single root.
 */
export function resolveDirectoryHere (context: DesktopCommandContext): string|undefined {
  if (context.focusPath !== undefined) {
    const focused = context.descriptors.get(context.focusPath)
    if (focused !== undefined) {
      return focused.type === 'directory' ? focused.path : focused.dir
    }
  }
  if (context.activeFilePath !== undefined) {
    const active = context.descriptors.get(context.activeFilePath)
    return active?.dir ?? pathDirname(context.activeFilePath)
  }
  if (context.selectedDirectory !== null) {
    return context.selectedDirectory
  }
  if (context.roots.length === 1) {
    const root = context.roots[0]
    return root.type === 'directory' ? root.path : root.dir
  }
  return undefined
}
