/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The Insert and Format items of the menus
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     One definition of each Insert and Format item that the
 *                  application menu and the context menus of the editor
 *                  share (#202): its id, its label and the editor command it
 *                  runs, the sizes of a new table and the text of that
 *                  table. The key of an item is the key of its registered
 *                  command (`commandForMenuItem`). The module imports neither
 *                  Electron nor a translation module: the main process and
 *                  the renderer give it their `trans`.
 *
 * END HEADER
 */

import { buildPipeMarkdownTable } from "@common/util/build-pipe-markdown-table";
import type { EditorCommandName } from "@dts/common/shortcut-names";

/** The `trans` of the process that builds a menu. */
export type Translate = (msgid: string, ...args: number[]) => string;

/** An item whose click runs an editor command. */
export interface EditorCommandMenuItem {
  readonly id: string;
  readonly label: string;
  readonly command: EditorCommandName;
}

/** An item of Insert → Table. */
export interface TableSizeMenuItem {
  readonly id: string;
  readonly label: string;
  readonly rows: number;
  readonly cols: number;
}

/** The Insert and Format items that run an editor command. */
export function editorCommandMenuItems(trans: Translate) {
  return {
    link: { id: "menu.insert_link", label: trans("Link"), command: "markdownLink" },
    image: { id: "menu.insert_image", label: trans("Image"), command: "markdownImage" },
    footnote: { id: "menu.insert_footnote", label: trans("Footnote"), command: "insertFootnote" },
    comment: { id: "menu.insert_comment", label: trans("Comment"), command: "markdownComment" },
    taskList: {
      id: "menu.insert_task_list",
      label: trans("Task list"),
      command: "markdownMakeTaskList",
    },
    bold: { id: "menu.format_bold", label: trans("Bold"), command: "markdownBold" },
    italic: { id: "menu.format_italic", label: trans("Italic"), command: "markdownItalic" },
    code: { id: "menu.format_code", label: trans("Code"), command: "markdownCode" },
    strikethrough: {
      id: "menu.format_strikethrough",
      label: trans("Strikethrough"),
      command: "markdownStrikethrough",
    },
    bulletList: {
      id: "menu.format_bullet_list",
      label: trans("Bullet list"),
      command: "markdownBulletList",
    },
    orderedList: {
      id: "menu.format_ordered_list",
      label: trans("Numbered list"),
      command: "markdownOrderedList",
    },
    blockquote: {
      id: "menu.format_blockquote",
      label: trans("Block quote"),
      command: "markdownBlockquote",
    },
  } as const satisfies Record<string, EditorCommandMenuItem>;
}

const TABLE_SIZES = [2, 3, 4] as const;

/** The submenu Insert → Table. */
export function tableMenu(trans: Translate): {
  id: string;
  label: string;
  sizes: TableSizeMenuItem[];
} {
  const sizes: TableSizeMenuItem[] = [];
  for (const rows of TABLE_SIZES) {
    for (const cols of TABLE_SIZES) {
      sizes.push({
        id: `menu.insert_table_${rows}x${cols}`,
        label: trans("%s rows × %s columns", rows, cols),
        rows,
        cols,
      });
    }
  }
  return { id: "menu.insert_table", label: trans("Table"), sizes };
}

/** The text of a new pipe table with empty cells. */
export function emptyPipeTable(rows: number, cols: number): string {
  const align = new Array<"center" | "left" | "right" | null>(cols).fill(null);
  const cells = Array.from({ length: rows }, () => new Array<string>(cols).fill(""));
  return buildPipeMarkdownTable(cells, align);
}

/** An item of the Edit menu. */
export interface EditMenuItem {
  readonly id: string;
  readonly label: string;
}

/** The items of the Edit menu that the context menus of the editor share. */
export function editMenuItems(trans: Translate) {
  return {
    cut: { id: "menu.cut", label: trans("Cut") },
    copy: { id: "menu.copy", label: trans("Copy") },
    copyAsHtml: { id: "menu.copy_html", label: trans("Copy as HTML") },
    paste: { id: "menu.paste", label: trans("Paste") },
    pasteAsPlain: { id: "menu.paste_plain", label: trans("Paste without style") },
    selectAll: { id: "menu.select_all", label: trans("Select all") },
  } as const satisfies Record<string, EditMenuItem>;
}
