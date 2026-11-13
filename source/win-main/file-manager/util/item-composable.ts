/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Item Mixin
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file contains a composable that manages a little bit of
 *                  state that is handled identically for both TreeItems and
 *                  FileItems.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import { reportError } from "@common/util/error-reporting";
import generateFilename from "@common/util/generate-filename";
import type { DocumentManagerIPCAPI } from "source/app/service-providers/documents";
import { hasImageExt, hasPDFExt } from "source/common/util/file-extention-checks";
import makeValidUri from "source/common/util/make-valid-uri";
import {
  useConfigStore,
  useDocumentTreeStore,
  useWindowStateStore,
  useWorkspaceStore,
} from "source/pinia";
import type { AnyDescriptor } from "source/types/common/fsal";
import { computed, nextTick, onUnmounted, type Ref, ref, watch } from "vue";
import { displayDirContext } from "./dir-item-context";
import { displayFileContext } from "./file-item-context";
import { type FileManagerSurface, type NameFieldKind, nameFieldsOf } from "./name-fields";

const ipcRenderer = window.ipc;

/**
 * Close the root files and workspaces at `paths` with each document inside
 * them, in one close. The command asks one time about unsaved text and keeps
 * each root when a document stays open.
 *
 * @param {string[]}  paths  The root paths to close
 */
export function closeRoots(paths: string[]): void {
  const workspaceStore = useWorkspaceStore();
  const roots = paths.filter((path) => workspaceStore.rootDescriptors.some((r) => r.path === path));
  if (roots.length === 0) {
    return;
  }

  ipcRenderer
    .invoke("application", {
      command: "root-close",
      payload: roots,
    })
    .catch((err) => reportError(err));
}

export function useItemComposable(
  object: AnyDescriptor,
  rootElement: Ref<HTMLElement | null>,
  windowId: string,
  nameEditingInput: Ref<HTMLInputElement | null>,
  newObjectInput: Ref<HTMLInputElement | null>,
  surface: FileManagerSurface,
) {
  const obj = ref(object);
  const showPopover = ref<boolean>(false);

  const configStore = useConfigStore();
  const documentTreeStore = useDocumentTreeStore();
  const windowStateStore = useWindowStateStore();

  const isDirectory = computed(() => obj.value.type === "directory");
  const selectedFile = computed(() => documentTreeStore.lastLeafActiveFile);
  const selectedDir = computed(() => configStore.config.openDirectory);

  // The name field of the row: a rename of the object, or the name of a new
  // file or folder in this folder (#202).
  const fields = nameFieldsOf(surface);
  const field = computed(() => fields.get(obj.value.path));

  function openField(kind: NameFieldKind): void {
    const text =
      kind === "rename"
        ? obj.value.name
        : kind === "createFile"
          ? generateFilename(configStore.config.newFileNamePattern, configStore.config.zkn.idGen)
          : trans("Untitled");
    fields.set(obj.value.path, { kind, text, selectOnFocus: true });
  }

  function closeField(kind: NameFieldKind): void {
    if (field.value?.kind === kind) {
      fields.delete(obj.value.path);
    }
  }

  const nameEditing = computed<boolean>({
    get: () => field.value?.kind === "rename",
    set: (open) => (open ? openField("rename") : closeField("rename")),
  });

  const operationType = computed<"createFile" | "createDir" | undefined>({
    get: () => {
      const kind = field.value?.kind;
      return kind === "createFile" || kind === "createDir" ? kind : undefined;
    },
    set: (kind) => {
      if (kind !== undefined) {
        openField(kind);
      } else if (operationType.value !== undefined) {
        closeField(operationType.value);
      }
    },
  });

  const fieldText = computed<string>({
    get: () => field.value?.text ?? "",
    set: (text) => {
      if (field.value !== undefined) {
        field.value.text = text;
      }
    },
  });

  // The field takes the focus when it opens and when this instance starts to
  // show the row of an open field. The first focus selects the name up to
  // its extension; a later one puts the caret after the text.
  watch(field, (current) => {
    if (current === undefined) {
      return;
    }
    nextTick()
      .then(() => {
        const input = current.kind === "rename" ? nameEditingInput.value : newObjectInput.value;
        if (input === null || field.value !== current) {
          return;
        }
        input.focus();
        if (current.selectOnFocus) {
          current.selectOnFocus = false;
          input.setSelectionRange(0, input.value.lastIndexOf("."));
        } else {
          input.setSelectionRange(input.value.length, input.value.length);
        }
      })
      .catch((err) => reportError(err));
  });

  onUnmounted(() => {
    if (field.value !== undefined) {
      fields.delete(obj.value.path);
    }
  });

  /**
   * Requests a file or directory to be selected and sends an appropriate
   * request to main.
   *
   * @param   {KeyboardEvent|MouseEvent}  event  The triggering event
   */
  function requestSelection(event: MouseEvent): void {
    // Dead directories can't be opened, so stop the propagation to
    // the file manager and don't do a thing.
    if (obj.value.type === "directory" && obj.value.dirNotFoundFlag === true) {
      return event.stopPropagation();
    }

    if (event.button === 2) {
      return; // The user requested a context menu
    }

    // Determine if we have a middle (wheel) click. The event-type check is
    // necessary since the left mouse button will have index 1 on click events,
    // whereas the middle mouse button will also have index 1, but on auxclick
    // events.
    const middleClick = event.type === "auxclick" && event.button === 1;
    const alt = event.altKey;
    const type = obj.value.type;

    // This item is the user's current filesystem context even if opening it
    // subsequently moves document state elsewhere. The command launcher uses
    // the volatile window state to implement "… here" desktop actions.
    windowStateStore.desktopFocusPath = obj.value.path;

    if (middleClick) {
      event.preventDefault(); // Otherwise, on Windows we'd have a middle-click-scroll
    }

    if (["file", "code"].includes(type)) {
      // Request the clicked file
      ipcRenderer
        .invoke("documents-provider", {
          command: "open-file",
          payload: {
            path: obj.value.path,
            windowId,
            leafId: documentTreeStore.lastLeafId,
            newTab: middleClick || (alt && type === "file"), // Force a new tab in this case.
          },
        } as DocumentManagerIPCAPI)
        .then(() => {
          configStore.setConfigValue("openDirectory", obj.value.dir);
          // Finally, since it's a directory, uncollapse it.
          if (!windowStateStore.uncollapsedDirectories.includes(obj.value.dir)) {
            windowStateStore.uncollapsedDirectories.push(obj.value.dir);
          }
        })
        .catch((e) => reportError(e));
    } else if (type === "other") {
      const { files } = configStore.config;
      // Determine if we can open the file in Zettlr
      if (
        (hasImageExt(obj.value.path) && files.images.openWith === "zettlr") ||
        (hasPDFExt(obj.value.path) && files.pdf.openWith === "zettlr")
      ) {
        ipcRenderer
          .invoke("documents-provider", {
            command: "open-file",
            // We leave leafId undefined
            payload: { path: obj.value.path, windowId },
          })
          .then(() => {
            configStore.setConfigValue("openDirectory", obj.value.dir);
            // Finally, since it's a directory, uncollapse it.
            if (!windowStateStore.uncollapsedDirectories.includes(obj.value.dir)) {
              windowStateStore.uncollapsedDirectories.push(obj.value.dir);
            }
          })
          .catch((e) => reportError(e));
      } else {
        // Open the file externally (again, NOTE, this only works because main
        // intercepts every navigation attempt).
        window.location.href = makeValidUri(obj.value.path);
      }
    } else if (alt) {
      // Select the parent directory
      configStore.setConfigValue("openDirectory", obj.value.dir);
    } else if (type === "directory") {
      configStore.setConfigValue("openDirectory", obj.value.path);
      // Finally, since it's a directory, uncollapse it.
      if (!windowStateStore.uncollapsedDirectories.includes(obj.value.path)) {
        windowStateStore.uncollapsedDirectories.push(obj.value.path);
      }
    }
  }

  /**
   * Handles a context menu on a file or directory item.
   *
   * @param   {MouseEvent}  event  The triggering contextmenu event
   */
  function handleContextMenu(event: MouseEvent): void {
    if (rootElement.value === null) {
      return;
    }

    if (obj.value.type === "directory") {
      displayDirContext(event, obj.value, rootElement.value, (clickedID) => {
        if (clickedID === "menu.rename_dir") {
          nameEditing.value = true;
        } else if (clickedID === "menu.new_file") {
          operationType.value = "createFile";
        } else if (clickedID === "menu.new_dir") {
          operationType.value = "createDir";
        } else if (clickedID === "menu.delete_dir") {
          ipcRenderer
            .invoke("application", {
              command: "dir-delete",
              payload: { path: obj.value.path },
            })
            .catch((err) => reportError(err));
        } else if (clickedID === "menu.close_workspace") {
          closeRoots([obj.value.path]);
        } else if (clickedID === "menu.project_build") {
          // We should trigger an export of this project.
          ipcRenderer
            .invoke("application", {
              command: "dir-project-export",
              payload: obj.value.path,
            })
            .catch((err) => reportError(err));
        } else if (clickedID === "menu.properties") {
          showPopover.value = true;
        }
      });
    } else {
      displayFileContext(event, obj.value, rootElement.value, (clickedID) => {
        if (clickedID === "new-tab") {
          // Request the clicked file, explicitly in a new tab
          ipcRenderer
            .invoke("documents-provider", {
              command: "open-file",
              payload: {
                path: obj.value.path,
                windowId,
                newTab: true,
              },
            } as DocumentManagerIPCAPI)
            .catch((e) => reportError(e));
        } else if (clickedID === "menu.rename_file") {
          nameEditing.value = true;
        } else if (clickedID === "menu.duplicate_file") {
          ipcRenderer
            .invoke("application", {
              command: "file-duplicate",
              payload: {
                path: obj.value.path,
                windowId,
                leafId: documentTreeStore.lastLeafId,
              },
            })
            .catch((err) => reportError(err));
        } else if (clickedID === "menu.delete_file") {
          ipcRenderer
            .invoke("application", {
              command: "file-delete",
              payload: { path: obj.value.path },
            })
            .catch((err) => reportError(err));
        } else if (clickedID === "properties") {
          showPopover.value = true;
        } else if (clickedID === "menu.close_file") {
          closeRoots([obj.value.path]);
        }
      });
    }
  }

  /**
   * Is called during drag operations.
   *
   * @param   {DragEvent}  event  The drag event.
   */
  function onDragHandler(event: DragEvent): void {
    if (obj.value.type === "directory") {
      return; // Directories cannot be dragged out of the app
    }

    // If the drag x/y-coordinates are about to leave the window, we
    // have to continue the drag in the main process (as it's being
    // dragged out of the window)
    const x = Number(event.x);
    const y = Number(event.y);
    const w = window.innerWidth;
    const h = window.innerHeight;

    if (x === 0 || y === 0 || x === w || y === h) {
      event.stopPropagation();
      event.preventDefault();

      ipcRenderer.send("window-controls", {
        command: "drag-start",
        payload: { filePath: obj.value.path },
      });
    }
  }

  /**
   * Called when the user finishes renaming the represented item
   *
   * @param   {string}  newName  The new name given to the file or directory
   */
  function finishNameEditing(newName: string): void {
    if (newName === obj.value.name) {
      nameEditing.value = false;
      return;
    }

    const command = obj.value.type === "directory" ? "dir-rename" : "file-rename";
    const path = obj.value.path;

    ipcRenderer
      .invoke("application", {
        command,
        payload: { path, name: newName },
      })
      .catch((e) => reportError(e))
      .finally(() => {
        if (fields.get(path)?.kind === "rename") {
          fields.delete(path);
        }
      });
  }

  // Enter in the name field of a new file or folder makes the object with
  // that name in this folder (#202).
  function finishOperation(newName: string): void {
    const operation = operationType.value;
    operationType.value = undefined;
    if (operation === undefined || newName.trim() === "") {
      return;
    }
    ipcRenderer
      .invoke("application", {
        command: operation === "createFile" ? "file-new" : "dir-new",
        payload: { path: obj.value.path, name: newName.trim() },
      })
      .catch((e) => reportError(e));
  }

  function updateObject(newObject: AnyDescriptor): void {
    obj.value = newObject;
  }

  return {
    nameEditing,
    showPopover,
    operationType,
    fieldText,
    onDragHandler,
    handleContextMenu,
    requestSelection,
    finishNameEditing,
    finishOperation,
    isDirectory,
    selectedFile,
    selectedDir,
    updateObject,
  };
}
