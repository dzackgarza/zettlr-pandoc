/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Shortcut names
 * CVM-Role:        Types
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The names the main process sends a window over the
 *                  `shortcut` channel: every application-menu item that acts
 *                  inside a window sends one, and the window's handlers are
 *                  keyed by them. The editor commands are shortcut names too:
 *                  an Insert or Format menu item sends the command it runs.
 *
 * END HEADER
 */

import { z } from 'zod'

/** The commands the Markdown editor runs by name (runCommand). */
export const EDITOR_COMMAND_NAMES = [
  'markdownComment',
  'markdownLink',
  'markdownImage',
  'insertFootnote',
  'markdownMakeTaskList',
  'createReferenceLabel',
  'markdownBold',
  'markdownItalic',
  'markdownCode',
  'markdownStrikethrough',
  'markdownHeading1',
  'markdownHeading2',
  'markdownHeading3',
  'markdownHeading4',
  'markdownHeading5',
  'markdownHeading6',
  'markdownBlockquote',
  'markdownBulletList',
  'markdownOrderedList'
] as const

export type EditorCommandName = typeof EDITOR_COMMAND_NAMES[number]

export function isEditorCommandName (value: string): value is EditorCommandName {
  return EDITOR_COMMAND_NAMES.some(name => name === value)
}

/** The window-level shortcut names the menu templates and the window provider send. */
export const WINDOW_SHORTCUT_NAMES = [
  'close-window',
  'copy-as-html',
  'copy-current-id',
  'delete-file',
  'export',
  'filter-files',
  'global-search',
  'insert-id',
  'insert-pandoc-div',
  'insert-pandoc-span',
  'insert-table',
  'navigate-back',
  'navigate-forward',
  'new-dir',
  'next-tab',
  'open-command-launcher',
  'pandoc-quick-help',
  'paste-as-plain',
  'previous-tab',
  'print',
  'rename-file',
  'save-file',
  'search',
  'toggle-annotation-panel',
  'toggle-distraction-free',
  'toggle-navigation-sidebar',
  'toggle-typewriter-mode'
] as const

export type WindowShortcutName = typeof WINDOW_SHORTCUT_NAMES[number]

export type ShortcutName = WindowShortcutName | EditorCommandName

export function isShortcutName (value: string): value is ShortcutName {
  return WINDOW_SHORTCUT_NAMES.some(name => name === value) || isEditorCommandName(value)
}

/** The one shortcut that carries a payload: the table size to insert. */
export const insertTablePayloadSchema = z.object({
  rows: z.number().int().min(1).max(12),
  cols: z.number().int().min(1).max(12)
})

export type InsertTablePayload = z.infer<typeof insertTablePayloadSchema>
