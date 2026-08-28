<template>
  <SplitView
    :initial-size-percent="[ 20, 80 ]"
    :minimum-size-percent="[ 20, 20 ]"
    :reset-size-percent="[ 20, 80 ]"
    :split="'horizontal'"
    :initial-total-width="100"
  >
    <template #view1>
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
    <template #view2>
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
            :readonly="currentItem < 0"
          />
          <!-- This div is used to keep the buttons in a line despite the flex -->
          <div class="save-asset-file">
            <ButtonControl
              :primary="true"
              :label="saveButtonLabel"
              :inline="true"
              :disabled="currentItem < 0 || (codeEditor != null && codeEditor.isClean())"
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
  </SplitView>
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
import CodeEditor from "@common/vue/CodeEditor.vue";
import ButtonControl from "@common/vue/form/elements/ButtonControl.vue";
import SelectableList, {
  type SelectableListItem,
} from "@common/vue/form/elements/SelectableList.vue";
import TextControl from "@common/vue/form/elements/TextControl.vue";
import SplitView from "@common/vue/window/SplitView.vue";
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
      if (
        typeof selectAfterUpdate === "string" &&
        availableFilters.value.includes(selectAfterUpdate)
      ) {
        currentItem.value = availableFilters.value.indexOf(selectAfterUpdate);
      }
      loadState();
    })
    .catch((err) => console.error(err));
}

function getProtectedFilters(): void {
  ipcRenderer
    .invoke("assets-provider", { command: "list-protected-filter" })
    .then((files) => {
      protectedFilters.value = files;
    })
    .catch((err) => console.error(err));
}

function loadState(): void {
  if (availableFilters.value.length === 0) {
    editorContents.value = "";
    codeEditor.value?.markClean();
    savingStatus.value = "";
    currentFilterText.value = "";
    currentItem.value = -1;
    return; // No state to load, only an error to avoid
  }

  if (currentItem.value >= availableFilters.value.length) {
    currentItem.value = availableFilters.value.length - 1;
  } else if (currentItem.value < 0) {
    currentItem.value = 0;
  }

  ipcRenderer
    .invoke("assets-provider", {
      command: "get-filter",
      payload: {
        filename: availableFilters.value[currentItem.value],
      },
    })
    .then((data) => {
      editorContents.value = data;
      codeEditor.value?.markClean();
      lastLoadedEditorContents.value = data;
      savingStatus.value = "";
      currentFilterText.value = availableFilters.value[currentItem.value];
    })
    .catch((err) => console.error(err));
}

function saveFilter(): void {
  savingStatus.value = trans("Saving …");

  ipcRenderer
    .invoke("assets-provider", {
      command: "set-filter",
      payload: {
        filename: availableFilters.value[currentItem.value],
        contents: editorContents.value,
      },
    })
    .then(() => {
      lastLoadedEditorContents.value = editorContents.value;
      savingStatus.value = trans("Saved!");
      setTimeout(() => {
        savingStatus.value = "";
      }, 1000);
    })
    .catch((err) => {
      savingStatus.value = trans("Could not save changes");
      console.error(err);
    });
}

function addFilter(newName?: string): void {
  // Adds a filter with empty contents and a generic default name
  if (newName !== undefined) {
    newName = newName.trim();
  }
  if (newName === undefined || newName === "") {
    newName = ensureUniqueName("filter");
  }

  ipcRenderer
    .invoke("assets-provider", {
      command: "set-filter",
      payload: {
        filename: newName,
        contents: "",
      },
    })
    .then(() => {
      updateAvailableFilters(newName);
    })
    .catch((err) => console.error(err));
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
    .catch((err) => console.error(err));
}

function renameFilter(): void {
  let newVal = currentFilterText.value;

  // Sanitise the name
  newVal = newVal.replace(/[^a-zA-Z0-9_-]/g, "-");

  newVal = ensureUniqueName(newVal);

  ipcRenderer
    .invoke("assets-provider", {
      command: "rename-filter",
      payload: {
        oldName: availableFilters.value[currentItem.value],
        newName: newVal,
      },
    })
    .then(() => {
      updateAvailableFilters(newVal);
    })
    .catch((err) => console.error(err));
}

/**
 * Ensures that the given name candidate describes a unique filter filename
 *
 * @param   {string}  candidate  The candidate's name
 *
 * @return  {string}             The candidate's name, with a number suffix (-X) if necessary
 */
function ensureUniqueName(candidate: string): string {
  if (!availableFilters.value.includes(candidate)) {
    return candidate; // No duplicate detected
  }

  let count = 1;
  const match = /-(\d+)$/.exec(candidate);

  if (match !== null) {
    // The candidate name already ends with a number-suffix --> extract it
    count = parseInt(match[1], 10);
    candidate = candidate.substring(0, candidate.length - match[1].length - 1);
  }

  while (availableFilters.value.includes(candidate + "-" + String(count))) {
    count++;
  }

  return candidate + "-" + count;
}

function openFilterDirectory(): void {
  ipcRenderer
    .invoke("assets-provider", {
      command: "open-filter-directory",
    })
    .catch((err) => console.error(err));
}
</script>

<style lang="css" scoped>
</style>
