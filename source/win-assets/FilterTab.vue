<template>
  <ListDetailSplit>
    <template #list>
      <div class="asset-container-list">
        <SelectableList
          :items="listItems"
          :selected-item="currentItem"
          :editable="true"
          :add-text-item="true"
          @add="addFilter($event)"
          @select="currentItem = $event"
          @remove="removeFilter($event)"
        />
        <ButtonControl
          :label="openFilterFolderLabel"
          :inline="false"
          @click="openFilterDirectory"
        />
      </div>
    </template>
    <template #detail>
      <div class="asset-container">
        <ZtrAdmonition
          type="info"
          class="asset-admonition"
        >
          {{ filterExplanation }}
        </ZtrAdmonition>
        <template v-if="currentItem < 0">
          <ZtrAdmonition
            type="warning"
            class="asset-admonition"
          >
            {{ noFilterMessage }}
          </ZtrAdmonition>
        </template>
        <template v-else>
          <p class="asset-input">
            <TextControl
              v-model="currentFilterText"
              class="asset-input-name"
              :inline="false"
              :disabled="currentItem < 0"
              @confirm="renameFilter()"
            />
            <ButtonControl
              class="asset-input-button"
              :label="renameFilterLabel"
              :inline="true"
              :disabled="availableFilters.length === 0 || currentFilterText === availableFilters[currentItem]"
              @click="renameFilter()"
            />
          </p>
          <ZtrAdmonition
            v-if="currentItem >= 0 && protectedFilters.includes(availableFilters[currentItem])"
            type="warning"
            class="asset-admonition"
          >
            {{ protectedFilterWarning }}
          </ZtrAdmonition>
          <CodeEditor
            ref="codeEditor"
            v-model="editorContents"
            :mode="'lua'"
            :readonly="!editable"
          />
          <!-- This div is used to keep the buttons in a line despite the flex -->
          <div class="save-asset-file">
            <ButtonControl
              :primary="true"
              :label="saveButtonLabel"
              :inline="true"
              :disabled="!editable || (codeEditor != null && codeEditor.isClean())"
              @click="saveFilter()"
            />
            <span
              v-if="savingStatus !== ''"
              class="saving-status"
            >{{ savingStatus }}</span>
          </div>
        </template>
      </div>
    </template>
  </ListDetailSplit>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        FilterTab
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This view exposes the Lua filters to the user.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import { showRefusal } from "@common/util/show-refusal";
import CodeEditor from "@common/vue/CodeEditor.vue";
import ButtonControl from "@common/vue/form/elements/ButtonControl.vue";
import SelectableList, {
  type SelectableListItem,
} from "@common/vue/form/elements/SelectableList.vue";
import TextControl from "@common/vue/form/elements/TextControl.vue";
import ListDetailSplit from "@common/vue/window/ListDetailSplit.vue";
import ZtrAdmonition from "source/common/vue/ZtrAdmonition.vue";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

const ipcRenderer = window.ipc;

// The mounted CodeEditor instance. The previous code called
// CodeEditor.value on the imported component object, which is always
// undefined at runtime, so markClean()/isClean() never ran.
// NOTE: This mirrors CodeEditor.vue's defineExpose surface; the SFC's own
// instance type is not resolvable from here.
interface CodeEditorAPI {
  isClean: () => boolean;
  markClean: () => void;
}
const codeEditor = ref<CodeEditorAPI | null>(null);

const noFilterMessage = trans("No filter selected.");
const protectedFilterWarning = trans(
  "This filter is protected. It will be restored if you rename or remove this file.",
);
const saveButtonLabel = trans("Save");
const renameFilterLabel = trans("Rename filter");
const filterExplanation = trans("Lua filters allow customization of your Pandoc exports.");
const openFilterFolderLabel = trans("Open filters folder");

const currentItem = ref(-1);
const currentFilterText = ref("");
const editorContents = ref("");
const lastLoadedEditorContents = ref("");
const savingStatus = ref("");
// Whether the editor holds the text of the selected filter. It does not
// while the text loads, and when the file refused the read.
const editable = ref(false);
const availableFilters = ref<string[]>([]);
const protectedFilters = ref<string[]>([]);

const listItems = computed<SelectableListItem[]>(() => {
  return availableFilters.value.map((filter) => {
    return {
      displayText: filter.substring(0, filter.lastIndexOf(".")),
      icon: protectedFilters.value.includes(filter) ? "lock" : undefined,
      solidIcon: true,
    };
  });
});

watch(currentItem, () => {
  loadState();
});

watch(editorContents, () => {
  if (editorContents.value === lastLoadedEditorContents.value) {
    savingStatus.value = "";
  } else {
    savingStatus.value = trans("Unsaved changes");
  }
});

// Immediately update the available filters
updateAvailableFilters();

const offCallback = ipcRenderer.on("shortcut", (event, shortcut) => {
  if (shortcut === "save-file") {
    saveFilter();
  }
});

onMounted(() => {
  getProtectedFilters();
});

onUnmounted(() => {
  offCallback();
});

function updateAvailableFilters(selectAfterUpdate?: string): void {
  ipcRenderer
    .invoke("assets-provider", { command: "list-filter" })
    .then((data) => {
      availableFilters.value = data;
      const selected =
        selectAfterUpdate === undefined ? -1 : availableFilters.value.indexOf(selectAfterUpdate);
      // A new selection loads its filter through the watcher.
      if (selected !== -1 && selected !== currentItem.value) {
        currentItem.value = selected;
        return;
      }
      loadState();
    })
    .catch(showRefusal);
}

function getProtectedFilters(): void {
  ipcRenderer
    .invoke("assets-provider", { command: "list-protected-filter" })
    .then((files) => {
      protectedFilters.value = files;
    })
    .catch(showRefusal);
}

/** Puts a text into the editor as the saved text of the selected filter. */
function showText(text: string): void {
  editorContents.value = text;
  codeEditor.value?.markClean();
  lastLoadedEditorContents.value = text;
  savingStatus.value = "";
}

function loadState(): void {
  if (availableFilters.value.length === 0) {
    showText("");
    editable.value = false;
    currentFilterText.value = "";
    currentItem.value = -1;
    return; // No state to load, only an error to avoid
  }

  if (currentItem.value >= availableFilters.value.length) {
    currentItem.value = availableFilters.value.length - 1;
  } else if (currentItem.value < 0) {
    currentItem.value = 0;
  }

  const filename = availableFilters.value[currentItem.value];
  const isSelected = (): boolean => availableFilters.value[currentItem.value] === filename;

  ipcRenderer.invoke("assets-provider", { command: "get-filter", payload: { filename } }).then(
    (data) => {
      // The author selected another filter while this one loaded.
      if (!isSelected()) {
        return;
      }
      showText(data);
      editable.value = true;
      currentFilterText.value = filename;
    },
    (failure: Error) => {
      // The window does not have the text of this filter. It shows no
      // text of another filter, and it offers no save.
      if (isSelected()) {
        showText("");
        editable.value = false;
        currentFilterText.value = filename;
      }
      showRefusal(failure);
    },
  );
}

function saveFilter(): void {
  if (!editable.value) {
    return;
  }

  const contents = editorContents.value;
  const saved = trans("Saved!");
  savingStatus.value = trans("Saving …");

  ipcRenderer
    .invoke("assets-provider", {
      command: "set-filter",
      payload: { filename: availableFilters.value[currentItem.value], contents },
    })
    .then(
      () => {
        lastLoadedEditorContents.value = contents;
        if (editorContents.value !== contents) {
          savingStatus.value = trans("Unsaved changes");
          return;
        }
        codeEditor.value?.markClean();
        savingStatus.value = saved;
        setTimeout(() => {
          if (savingStatus.value === saved) {
            savingStatus.value = "";
          }
        }, 1000);
      },
      (failure: Error) => {
        savingStatus.value = trans("Unsaved changes");
        showRefusal(failure);
      },
    );
}

function addFilter(newName?: string): void {
  // A filter without a name of the author gets a name that no filter has.
  // A name of the author that a filter has is refused: no filter is replaced.
  const typed = newName === undefined ? "" : newName.trim();
  const filename = typed === "" ? freeFilterName("filter") : typed;

  ipcRenderer
    .invoke("assets-provider", { command: "create-filter", payload: { filename } })
    .then((created) => {
      updateAvailableFilters(created);
    })
    .catch(showRefusal);
}

function removeFilter(idx: number): void {
  if (idx > availableFilters.value.length - 1 || idx < 0) {
    return;
  }

  // Remove the current filter.
  ipcRenderer
    .invoke("assets-provider", {
      command: "remove-filter",
      payload: { filename: availableFilters.value[idx] },
    })
    .then(() => {
      updateAvailableFilters();
    })
    .catch(showRefusal);
}

function renameFilter(): void {
  // The field shows the name with its extension, so the author can write
  // the new name with it. The rest of the name is sanitised.
  const typed = currentFilterText.value.trim().replace(/\.lua$/i, "");
  const newName = `${typed.replace(/[^a-zA-Z0-9_-]/g, "-")}.lua`;

  ipcRenderer
    .invoke("assets-provider", {
      command: "rename-filter",
      payload: { oldName: availableFilters.value[currentItem.value], newName },
    })
    .then(() => {
      updateAvailableFilters(newName);
    })
    .catch(showRefusal);
}

/**
 * A name that no filter of the list has: the candidate, or the candidate
 * with the first free number.
 */
function freeFilterName(candidate: string): string {
  const isTaken = (name: string): boolean => availableFilters.value.includes(`${name}.lua`);
  if (!isTaken(candidate)) {
    return candidate;
  }

  let count = 1;
  while (isTaken(`${candidate}-${count}`)) {
    count++;
  }
  return `${candidate}-${count}`;
}

function openFilterDirectory(): void {
  ipcRenderer.invoke("assets-provider", { command: "open-filter-directory" }).catch(showRefusal);
}
</script>

<style lang="css" scoped>
</style>
