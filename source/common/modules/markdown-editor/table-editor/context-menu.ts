import { type EditorView } from "@codemirror/view";
import { platformAccelerator } from "@common/commands/command-registry";
import { trans } from "@common/i18n-renderer";
import showPopupMenu, { type AnyMenuItem } from "../../window-register/application-menu-helper";
import { applyBold, applyItalic, insertLink } from "../commands/markdown";
import { editorMenuAccelerator } from "../context-menu/menu-accelerator";
import { getTransformSubmenu } from "../context-menu/transform-items";
import { type EditorShortcutName } from "../keymaps/shortcuts";
import { selectAllCommand } from "../keymaps/table-editor";
import { copyAsHTML, copyAsPlain, cut, paste, pasteAsPlain } from "../util/copy-paste-cut";
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

  const template: AnyMenuItem[] = [
    {
      label: trans("Bold"),
      accelerator: sc("md-bold"),
      type: "normal",
      action() {
        applyBold(subviewOrView);
      },
    },
    {
      label: trans("Italic"),
      accelerator: sc("md-italic"),
      type: "normal",
      action() {
        applyItalic(subviewOrView);
      },
    },
    {
      type: "separator",
    },
    {
      label: trans("Insert link"),
      accelerator: sc("md-insert-link"),
      type: "normal",
      action() {
        insertLink(subviewOrView);
      },
    },
    {
      type: "separator",
    },
    {
      label: trans("Cut"),
      accelerator: platformAccelerator("cut"),
      type: "normal",
      action() {
        cut(subviewOrView);
      },
    },
    {
      label: trans("Copy"),
      accelerator: platformAccelerator("copy"),
      type: "normal",
      action() {
        copyAsPlain(subviewOrView);
      },
    },
    {
      label: trans("Copy as HTML"),
      accelerator: sc("edit-copy-as-html"),
      type: "normal",
      action() {
        copyAsHTML(subviewOrView);
      },
    },
    {
      label: trans("Paste"),
      accelerator: platformAccelerator("paste"),
      type: "normal",
      action() {
        paste(subviewOrView);
      },
    },
    {
      label: trans("Paste without style"),
      accelerator: sc("edit-paste-as-plain"),
      type: "normal",
      action() {
        pasteAsPlain(subviewOrView);
      },
    },
    {
      type: "separator",
    },
    {
      label: trans("Select all"),
      accelerator: platformAccelerator("select-all"),
      type: "normal",
      action() {
        selectAllCommand(subviewOrView);
      },
    },
    {
      type: "separator",
    },
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
