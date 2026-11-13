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
