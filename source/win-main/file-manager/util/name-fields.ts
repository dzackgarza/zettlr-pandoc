/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        nameFieldsOf
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The open name fields (rename, new file, new folder) of the
 *                  tree and of the file list, by the path of their row.
 *
 * END HEADER
 */

import { reactive } from "vue";

export type NameFieldKind = "rename" | "createFile" | "createDir";

export interface NameField {
  kind: NameFieldKind;
  /** The text of the field. */
  text: string;
  /** True until the field had the focus once: the first focus selects the name. */
  selectOnFocus: boolean;
}

export type FileManagerSurface = "tree" | "list";

// The file list is a virtual scroller: it gives a component instance to
// another row when the rows change or scroll. A field belongs to its row, so
// its state is kept by the path of the row and not in the instance.
const fields: Record<FileManagerSurface, Map<string, NameField>> = {
  tree: reactive(new Map()),
  list: reactive(new Map()),
};

/** The open name fields of one surface of the window, by the path of their row. */
export function nameFieldsOf(surface: FileManagerSurface): Map<string, NameField> {
  return fields[surface];
}

/** The row element of each surface, as the components of the rows render it. */
const ROW_SELECTOR: Record<FileManagerSurface, string> = {
  list: "#file-list .list-item[data-path]",
  tree: "#file-tree .tree-item[data-path]",
};

/**
 * Whether the author sees the row: a hidden file manager has no width
 * (`paneSlide`) and keeps its rows.
 */
function isShown(row: HTMLElement): boolean {
  const box = row.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && row.checkVisibility({ visibilityProperty: true });
}

/**
 * Open the rename field of the row of `filePath`, in the list or the tree,
 * whichever shows that row (#202): the context menu of a row and the key of
 * "Rename file" ask for the name in one field.
 *
 * @param   filePath  The path of the file
 * @param   name      The name of the file, the text of the field
 *
 * @return  False when the file manager shows no row of the file
 */
export function openRowRenameField(filePath: string, name: string): boolean {
  for (const surface of ["list", "tree"] as const) {
    const row = Array.from(document.querySelectorAll<HTMLElement>(ROW_SELECTOR[surface])).find(
      (element) => element.dataset.path === filePath && isShown(element),
    );
    if (row !== undefined) {
      row.scrollIntoView({ block: "nearest" });
      fields[surface].set(filePath, { kind: "rename", text: name, selectOnFocus: true });
      return true;
    }
  }
  return false;
}
