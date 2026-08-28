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
          :editable="true"
          :selected-item="currentItem"
          :add-text-item="true"
          @select="currentItem = $event"
          @add="newDefaultsFile($event)"
          @remove="removeFile($event)"
        />
        <ButtonControl
          :label="openDefaultsFolderLabel"
          :inline="false"
          @click="openDefaultsDirectory"
        />
      </div>
    </template>
    <template #view2>
      <div class="asset-container">
        <ZtrAdmonition
          type="info"
          class="asset-admonition"
        >
          {{ defaultsExplanation }}
        </ZtrAdmonition>
        <p class="asset-input">
          <TextControl
            v-model="currentFilename"
            class="asset-input-name"
            :inline="false"
            :disabled="currentItem < 0"
            @confirm="renameFile()"
          />
          <ButtonControl
            class="asset-input-button"
            :label="renameFileLabel"
            :inline="true"
            :disabled="visibleItems.length === 0 || currentFilename === visibleItems[currentItem].name"
            @click="renameFile()"
          />
        </p>
        <ZtrAdmonition
          v-if="visibleItems.length > 0 && visibleItems[currentItem].isProtected === true"
          type="warning"
          class="asset-admonition"
        >
          {{ protectedProfileWarning }}
        </ZtrAdmonition>
        <ZtrAdmonition
          v-if="visibleItems[currentItem]?.isInvalid"
          class="asset-admonition"
        >
          {{ invalidProfileWarning }}
        </ZtrAdmonition>
        <CodeEditor
          ref="code-editor"
          v-model="editorContents"
          :mode="'yaml'"
        />
        <!-- This div is used to keep the buttons in a line despite the flex -->
        <div class="save-asset-file">
          <ButtonControl
            class="save-button"
            :primary="true"
            :label="saveButtonLabel"
            :inline="true"
            @click="saveDefaultsFile()"
          />
          <span
            v-if="savingStatus !== ''"
            class="saving-status"
          >{{ savingStatus }}</span>
        </div>
      </div>
    </template>
  </SplitView>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Defaults
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This is the defaults file editor view. It allows users to
 *                  modify the provided defaults files.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import { PANDOC_READERS, PANDOC_WRITERS, SUPPORTED_READERS } from "@common/pandoc-util/pandoc-maps";
import CodeEditor from "@common/vue/CodeEditor.vue";
import ButtonControl from "@common/vue/form/elements/ButtonControl.vue";
import SelectableList, {
  type SelectableListItem,
} from "@common/vue/form/elements/SelectableList.vue";
import TextControl from "@common/vue/form/elements/TextControl.vue";
import SplitView from "@common/vue/window/SplitView.vue";
import ZtrAdmonition from "@common/vue/ZtrAdmonition.vue";
import type { PandocProfileMetadata, ValidPandocProfile } from "@providers/assets";
import { DateTime } from "luxon";
import sanitizeFilename from "sanitize-filename";
import { parseReaderWriter } from "source/common/pandoc-util/parse-reader-writer";
import { computed, onUnmounted, ref, toRef, watch } from "vue";

const ipcRenderer = window.ipc;

const NEW_DEFAULTS_FILE_CONTENTS = `# This is a new defaults file that you can use to define rules for exporting or
# importing files to and from Zettlr. The only two required properties are the
# writer and reader ones. Without them, Zettlr will not be able to export or
# import your files. You can choose any reader or writer that is supported by
# Pandoc. Zettlr will automatically show the profile at appropriate locations
# based on the values of the writer and reader properties.
# More info: https://pandoc.org/MANUAL.html.
reader: markdown
writer: markdown
`;
const props = defineProps<{
  // "which" describes which kind of defaults files this instance controls
  // can be "import" (for any --> Markdown) or "export" (for Markdown --> any)
  which: "import" | "export";
}>();

const currentItem = ref(0);
const currentFilename = ref("");
const editorContents = ref("");
const lastLoadedEditorContents = ref("");
const savingStatus = ref("");
const availableDefaultsFiles = ref<PandocProfileMetadata[]>([]);

const protectedProfileWarning = trans(
  "This profile is protected. This means that it will be restored when you remove or rename it.",
);
const invalidProfileWarning = trans(
  "This profile is invalid. It may contain errors, or it may be missing the writer or reader property.",
);
const renameFileLabel = trans("Rename file");
const openDefaultsFolderLabel = trans("Open defaults folder");
const defaultsExplanation = trans("Edit the default settings for imports or exports here.");
const saveButtonLabel = trans("Save");

// <PandocProfileMetadata[]>
const visibleItems = computed(() => {
  // Display either the exporting or importing formats depending on the tab
  return availableDefaultsFiles.value.filter((e) => {
    if (e.isInvalid) {
      return true; // We always need to show invalid files so users can fix them
    }
    // Retrieve which one we need to check
    const readerWriter = props.which === "import" ? e.writer : e.reader;
    const parsedReaderWriter = parseReaderWriter(readerWriter);
    return SUPPORTED_READERS.includes(parsedReaderWriter.name);
  });
});

/**
 * Describes the conversion a profile performs, resolving known and fully
 * supported extensions to their display names.
 */
function conversionText(file: ValidPandocProfile): string {
  const parsedReader = parseReaderWriter(file.reader);
  const parsedWriter = parseReaderWriter(file.writer);
  const reader =
    parsedReader.name in PANDOC_READERS ? PANDOC_READERS[parsedReader.name] : parsedReader.name;
  const writer =
    parsedWriter.name in PANDOC_WRITERS ? PANDOC_WRITERS[parsedWriter.name] : parsedWriter.name;
  return [reader, writer].join(" → ");
}

const listItems = computed<SelectableListItem[]>(() => {
  return visibleItems.value.map((file) => {
    return {
      displayText: file.name.substring(0, file.name.lastIndexOf(".")),
      icon: file.isProtected === true ? "lock" : undefined,
      solidIcon: true,
      infoString: file.isInvalid ? "Invalid" : conversionText(file),
      infoStringClass: file.isInvalid ? "error" : undefined,
    };
  });
});

watch(toRef(props, "which"), function () {
  // Reset to the beginning of the list. The watcher right below will pick
  // that change up and re-load the defaults.
  currentItem.value = -1;
  loadDefaultsForState().catch((e) => console.error(e));
});

watch(currentItem, () => {
  loadDefaultsForState().catch((e) => console.error(e));
});

watch(editorContents, () => {
  if (editorContents.value === lastLoadedEditorContents.value) {
    savingStatus.value = "";
  } else {
    savingStatus.value = trans("Unsaved changes");
  }
});

retrieveDefaultsFiles()
  .then(() => {
    loadDefaultsForState().catch((e) => console.error(e));
  })
  .catch((e) => console.error(e));

const offCallback = ipcRenderer.on("shortcut", (event, shortcut) => {
  if (shortcut === "save-file") {
    saveDefaultsFile();
  }
});
onUnmounted(() => {
  offCallback();
});

async function loadDefaultsForState(): Promise<void> {
  // Loads a defaults file from main for the given state (tab + list item)
  if (availableDefaultsFiles.value.length === 0) {
    currentFilename.value = "";
    return;
  }

  if (visibleItems.value.length === 0) {
    return;
  }

  if (currentItem.value < 0) {
    currentItem.value = 0;
  }

  if (currentItem.value >= visibleItems.value.length) {
    currentItem.value = visibleItems.value.length - 1;
  }

  const name = visibleItems.value[currentItem.value].name;

  const data = await ipcRenderer.invoke("assets-provider", {
    command: "get-defaults-file",
    payload: { filename: name },
  });

  lastLoadedEditorContents.value = data;
  editorContents.value = data;
  currentFilename.value = visibleItems.value[currentItem.value].name;
}

async function retrieveDefaultsFiles(): Promise<void> {
  // NOTE: Here we are explicitly requesting only the defaults files, not
  // all export profiles, because here it's only about modifying them (which
  // does not work with the custom profiles the exporter provides).
  const files: PandocProfileMetadata[] = await ipcRenderer.invoke("assets-provider", {
    command: "list-defaults",
  });

  availableDefaultsFiles.value = files;
  if (currentItem.value < 0) {
    currentItem.value = 0;
  }

  await loadDefaultsForState();
}

function saveDefaultsFile(): void {
  savingStatus.value = trans("Saving …");

  const name = visibleItems.value[currentItem.value].name;

  ipcRenderer
    .invoke("assets-provider", {
      command: "set-defaults-file",
      payload: { filename: name, contents: editorContents.value },
    })
    .then(async () => {
      lastLoadedEditorContents.value = editorContents.value;
      savingStatus.value = trans("Saved!");
      await retrieveDefaultsFiles(); // Always make sure to pull in any changes
      setTimeout(() => {
        savingStatus.value = "";
      }, 1000);
    })
    .catch((err) => {
      savingStatus.value = trans("Could not save changes");
      console.error(err);
    });
}

function newDefaultsFile(newName?: string): void {
  // Create a new defaults file
  const dt = DateTime.now();
  const timeString = dt.toISOTime({
    includeOffset: false,
    suppressMilliseconds: true,
  });

  if (newName !== undefined) {
    newName = newName.trim();
  }

  if (newName === undefined || newName === "") {
    newName = `New Profile ${dt.toISODate()} ${timeString}.yaml`;
  }

  ipcRenderer
    .invoke("assets-provider", {
      command: "set-defaults-file",
      payload: { filename: newName, contents: NEW_DEFAULTS_FILE_CONTENTS },
    })
    .then(async () => {
      await retrieveDefaultsFiles(); // Always make sure to pull in any changes
      const idx = visibleItems.value.findIndex((val) => val.name === newName);
      currentItem.value = idx;
      console.log({ newName, idx });
    })
    .catch((err) => console.error(err));
}

function renameFile(): void {
  let newName = currentFilename.value;
  if (!newName.endsWith(".yaml") && !newName.endsWith(".yml")) {
    newName += ".yaml";
  }

  newName = sanitizeFilename(newName, { replacement: "-" });

  const oldName = visibleItems.value[currentItem.value].name;

  ipcRenderer
    .invoke("assets-provider", {
      command: "rename-defaults-file",
      payload: { oldName, newName },
    })
    .then(async () => {
      await retrieveDefaultsFiles(); // Always make sure to pull in any changes
    })
    .catch((err) => console.error(err));
}

function removeFile(idx: number): void {
  if (idx > visibleItems.value.length - 1 || idx < 0) {
    return;
  }

  const filename = visibleItems.value[idx].name;

  ipcRenderer
    .invoke("assets-provider", {
      command: "remove-defaults-file",
      payload: { filename },
    })
    .then(async () => {
      await retrieveDefaultsFiles(); // Always make sure to pull in any changes
    })
    .catch((err) => console.error(err));
}

function openDefaultsDirectory(): void {
  ipcRenderer
    .invoke("assets-provider", {
      command: "open-defaults-directory",
    })
    .catch((err) => console.error(err));
}
</script>

<style lang="css" scoped>
</style>
