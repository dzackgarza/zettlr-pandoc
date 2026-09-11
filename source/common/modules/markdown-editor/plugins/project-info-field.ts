/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Project info field
 * CVM-Role:        CodeMirror plugin
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     A small state field that contains various infos about the
 *                  associated Zettlr project, if the currently loaded file is
 *                  part of such a project.
 *
 * END HEADER
 */

import { StateEffect, StateField, type EditorState } from '@codemirror/state'
import type { AnyMenuItem } from '../../window-register/application-menu-helper'


export interface ProjectInfo {
  name: string // Project name
  files: Array<{ path: string, displayName: string }> // All files in the project
  navigation: ProjectInfoNavigationItem[]
  wordCount: number // Total words across project files
  charCount: number // Total characters across project files
}

export type ProjectInfoNavigationItem =
  | { kind: 'chapter', path: string, displayName: string }
  | { kind: 'part', title: string, chapters: Array<{ path: string, displayName: string }> }

/** The project's chapters as popup menu items, each carrying its document path as id. */
export function navigationMenuItems (navigation: ProjectInfoNavigationItem[]): AnyMenuItem[] {
  return navigation.map(item => {
    if (item.kind === 'chapter') {
      return {
        id: item.path,
        label: item.displayName,
        type: 'normal'
      }
    }

    return {
      label: item.title,
      type: 'submenu',
      submenu: item.chapters.map(chapter => ({
        id: chapter.path,
        label: chapter.displayName,
        type: 'normal'
      }))
    }
  })
}

/**
 * Use this effect to provide updated information about a project to the editor.
 */
export const projectInfoUpdateEffect = StateEffect.define<ProjectInfo|null>()

/**
 * This field can be used to provide to the editor further context information
 * on the file's association with a Zettlr project.
 */
export const projectInfoField = StateField.define<ProjectInfo|null>({
  create (_state: EditorState) {
    return null
  },
  update (value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(projectInfoUpdateEffect)) {
        value = effect.value
      }
    }

    return value
  }
})

