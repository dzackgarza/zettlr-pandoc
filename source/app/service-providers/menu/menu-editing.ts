/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Editing menus
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The application-menu items both platform templates share
 *                  for editing: the command launcher, the writing statistics,
 *                  and the Insert and Format menus. Each item is the one
 *                  definition of its command: the launcher's rows, labels,
 *                  shortcut chips and enablement come from these items over
 *                  the menu-provider IPC, and each click sends the window
 *                  the typed shortcut name that runs it.
 *
 * END HEADER
 */

import type { BaseWindow, BrowserWindow, MenuItemConstructorOptions } from 'electron'
import { trans } from '@common/i18n-main'
import { cmShortcutToElectron, getDefaultKeybinding } from 'source/common/util/shortcuts'
import { defaultKeybindings, type EditorShortcutName } from 'source/common/modules/markdown-editor/keymaps/shortcuts'
import type { EditorCommandName, InsertTablePayload, ShortcutName } from '@dts/common/shortcut-names'
import type { MenuCommands } from './menu-dependencies'

/** Electron types the focused window as possibly undefined; at runtime the provider also passes null. */
type FocusedWindow = BrowserWindow | BaseWindow | undefined | null

/** Sends a window the typed shortcut name (and, for a table, its size). */
export function sendShortcut (window: FocusedWindow, name: ShortcutName, payload?: InsertTablePayload): void {
  if (window === undefined || window === null || !('webContents' in window)) {
    return
  }
  if (payload === undefined) {
    window.webContents.send('shortcut', name)
  } else {
    window.webContents.send('shortcut', name, payload)
  }
}

/** The Electron accelerator of an editor shortcut's default binding, if it has one. */
function editorAccelerator (name: EditorShortcutName): string | undefined {
  return cmShortcutToElectron(getDefaultKeybinding(name, defaultKeybindings))
}

/** One Insert or Format item: its click sends the editor command it names. */
function editorCommandItem (
  id: string,
  label: string,
  command: EditorCommandName,
  shortcut?: EditorShortcutName
): MenuItemConstructorOptions {
  return {
    id,
    label,
    accelerator: shortcut === undefined ? undefined : editorAccelerator(shortcut),
    click: (_item, focusedWindow) => { sendShortcut(focusedWindow, command) }
  }
}

/** View → Command launcher…: the window-level Ctrl+P. */
export function commandLauncherItem (accelerator: string): MenuItemConstructorOptions {
  return {
    id: 'menu.command_launcher',
    label: trans('Command launcher…'),
    accelerator,
    click: (_item, focusedWindow) => { sendShortcut(focusedWindow, 'open-command-launcher') }
  }
}

/** View → Writing statistics…: the statistics window. */
export function statisticsItem (commands: MenuCommands): MenuItemConstructorOptions {
  return {
    id: 'menu.statistics',
    label: trans('Writing statistics…'),
    click: () => { commands.run('open-stats-window', undefined) }
  }
}
const TABLE_SIZES = [ 2, 3, 4 ] as const

/** The Insert menu: links, images, tables, footnotes, comments, Pandoc blocks, task lists. */
export function insertMenu (): MenuItemConstructorOptions {
  const tableSizes: MenuItemConstructorOptions[] = []
  for (const rows of TABLE_SIZES) {
    for (const cols of TABLE_SIZES) {
      tableSizes.push({
        id: `menu.insert_table_${rows}x${cols}`,
        label: trans('%s rows × %s columns', rows, cols),
        click: (_item, focusedWindow) => { sendShortcut(focusedWindow, 'insert-table', { rows, cols }) }
      })
    }
  }

  return {
    id: 'insert-menu',
    label: trans('Insert'),
    submenu: [
      editorCommandItem('menu.insert_link', trans('Link'), 'markdownLink', 'md-insert-link'),
      editorCommandItem('menu.insert_image', trans('Image'), 'markdownImage', 'md-insert-image'),
      {
        id: 'menu.insert_table',
        label: trans('Table'),
        submenu: tableSizes
      },
      editorCommandItem('menu.insert_footnote', trans('Footnote'), 'insertFootnote', 'md-insert-footnote'),
      editorCommandItem('menu.insert_comment', trans('Comment'), 'markdownComment', 'md-comment'),
      { type: 'separator' },
      {
        id: 'menu.insert_pandoc_div',
        label: trans('Pandoc div'),
        click: (_item, focusedWindow) => { sendShortcut(focusedWindow, 'insert-pandoc-div') }
      },
      {
        id: 'menu.insert_pandoc_span',
        label: trans('Pandoc span'),
        click: (_item, focusedWindow) => { sendShortcut(focusedWindow, 'insert-pandoc-span') }
      },
      { type: 'separator' },
      editorCommandItem('menu.insert_task_list', trans('Task list'), 'markdownMakeTaskList', 'md-task-list')
    ]
  }
}

/** The Format menu: headings, inline marks, lists and block quotes. */
export function formatMenu (): MenuItemConstructorOptions {
  const headings: MenuItemConstructorOptions[] = ([ 1, 2, 3, 4, 5, 6 ] as const).map(level => editorCommandItem(
    `menu.format_heading_${level}`,
    trans('Heading %s', level),
    `markdownHeading${level}`
  ))

  return {
    id: 'format-menu',
    label: trans('Format'),
    submenu: [
      ...headings,
      { type: 'separator' },
      editorCommandItem('menu.format_bold', trans('Bold'), 'markdownBold', 'md-bold'),
      editorCommandItem('menu.format_italic', trans('Italic'), 'markdownItalic', 'md-italic'),
      editorCommandItem('menu.format_code', trans('Code'), 'markdownCode'),
      editorCommandItem('menu.format_strikethrough', trans('Strikethrough'), 'markdownStrikethrough'),
      { type: 'separator' },
      editorCommandItem('menu.format_bullet_list', trans('Bullet list'), 'markdownBulletList'),
      editorCommandItem('menu.format_ordered_list', trans('Numbered list'), 'markdownOrderedList'),
      editorCommandItem('menu.format_blockquote', trans('Block quote'), 'markdownBlockquote')
    ]
  }
}
