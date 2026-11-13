import { type EditorView } from "@codemirror/view";
import { editMenuItems, editorCommandMenuItems } from "@common/commands/editing-menu-items";
import { trans } from "@common/i18n-renderer";
import showPopupMenu, { type AnyMenuItem } from "../../window-register/application-menu-helper";
import {
  editorCommandItem,
  editorMenuAccelerator,
  roleItem,
  viewItem,
} from "../context-menu/menu-accelerator";
import { getTransformSubmenu } from "../context-menu/transform-items";
import { type EditorShortcutName } from "../keymaps/shortcuts";
import { selectAllCommand } from "../keymaps/table-editor";
import { copyAsHTML, pasteAsPlain } from "../util/copy-paste-cut";
import {
  addColAfter,
  addColBefore,
  clearCol,
  deleteCol,
  swapNextCol,
  swapPrevCol,
} from "./commands/columns";
import {
  addRowAfter,
  addRowBefore,
  clearRow,
  deleteRow,
  swapNextRow,
  swapPrevRow,
} from "./commands/rows";
import { clearTable, deleteTable, setAlignment } from "./commands/tables";

export function displayTableContextMenu(
  event: MouseEvent,
  mainView: EditorView,
  subviewOrView: EditorView,
): void {
  const sc = (name: EditorShortcutName) => editorMenuAccelerator(mainView, name);
  const items = editorCommandMenuItems(trans);
  const edit = editMenuItems(trans);

  const template: AnyMenuItem[] = [
    editorCommandItem(subviewOrView, items.bold),
    editorCommandItem(subviewOrView, items.italic),
    { type: "separator" },
    editorCommandItem(subviewOrView, items.link),
    { type: "separator" },
    roleItem(subviewOrView, edit.cut),
    roleItem(subviewOrView, edit.copy),
    viewItem(subviewOrView, edit.copyAsHtml, copyAsHTML),
    roleItem(subviewOrView, edit.paste),
    viewItem(subviewOrView, edit.pasteAsPlain, pasteAsPlain),
    { type: "separator" },
    viewItem(subviewOrView, edit.selectAll, selectAllCommand),
    { type: "separator" },
    getTransformSubmenu(subviewOrView),
    {
      type: "separator",
    },
    {
      type: "submenu",
      label: trans("Row"),
      enabled: true,
      submenu: [
        {
          type: "normal",
          label: trans("Insert new row above"),
          accelerator: sc("table-add-row-before"),
          action() {
            addRowBefore(mainView);
          },
        },
        {
          type: "normal",
          label: trans("Insert new row below"),
          accelerator: sc("table-add-row-after"),
          action() {
            addRowAfter(mainView);
          },
        },
        { type: "separator" },
        {
          type: "normal",
          label: trans("Move row up"),
          accelerator: sc("table-swap-prev-row"),
          action() {
            swapPrevRow(mainView);
          },
        },
        {
          type: "normal",
          label: trans("Move row down"),
          accelerator: sc("table-swap-next-row"),
          action() {
            swapNextRow(mainView);
          },
        },
        { type: "separator" },
        {
          type: "normal",
          label: trans("Clear row"),
          action() {
            clearRow(mainView);
          },
        },
        {
          type: "normal",
          label: trans("Delete row"),
          action() {
            deleteRow(mainView);
          },
        },
      ],
    },
    {
      type: "submenu",
      label: trans("Column"),
      submenu: [
        {
          type: "normal",
          label: trans("Insert new column left"),
          accelerator: sc("table-add-col-before"),
          action() {
            addColBefore(mainView);
          },
        },
        {
          type: "normal",
          label: trans("Insert new column right"),
          accelerator: sc("table-add-col-after"),
          action() {
            addColAfter(mainView);
          },
        },
        { type: "separator" },
        {
          type: "normal",
          label: trans("Move column left"),
          accelerator: sc("table-swap-prev-col"),
          action() {
            swapPrevCol(mainView);
          },
        },
        {
          type: "normal",
          label: trans("Move column right"),
          accelerator: sc("table-swap-next-col"),
          action() {
            swapNextCol(mainView);
          },
        },
        { type: "separator" },
        {
          type: "normal",
          label: trans("Align column text left"),
          accelerator: sc("table-align-col-left"),
          action() {
            setAlignment("left")(mainView);
          },
        },
        {
          type: "normal",
          label: trans("Align column text center"),
          accelerator: sc("table-align-col-center"),
          action() {
            setAlignment("center")(mainView);
          },
        },
        {
          type: "normal",
          label: trans("Align column text right"),
          accelerator: sc("table-align-col-right"),
          action() {
            setAlignment("right")(mainView);
          },
        },
        { type: "separator" },
        // {
        //   type: 'normal',
        //   label: trans('Sort column A-Z'),
        //   id: 'sort.col.asc',
        //   enabled: true
        // },
        // {
        //   type: 'normal',
        //   label: trans('Sort column Z-A'),
        //   id: 'sort.col.desc',
        //   enabled: true
        // },
        // { type: 'separator' },
        {
          type: "normal",
          label: trans("Clear column"),
          action() {
            clearCol(mainView);
          },
        },
        {
          type: "normal",
          label: trans("Delete column"),
          action() {
            deleteCol(mainView);
          },
        },
      ],
    },
    {
      type: "submenu",
      label: trans("Table"),
      submenu: [
        {
          type: "normal",
          label: trans("Clear table"),
          action() {
            clearTable(mainView);
          },
        },
        {
          type: "normal",
          label: trans("Delete table"),
          id: "delete.table",
          action() {
            deleteTable(mainView);
          },
        },
      ],
    },
  ];

  const point = { x: event.clientX, y: event.clientY };
  showPopupMenu(point, template);
}
