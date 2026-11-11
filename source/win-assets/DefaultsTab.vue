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
            :disabled="visibleItems[currentItem] === undefined || currentFilename === visibleItems[currentItem].name"
            @click="renameFile()"
          />
        </p>
        <ZtrAdmonition
          v-if="visibleItems[currentItem]?.isProtected === true"
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
          v-model="editorContents"
          :mode="'yaml'"
          :readonly="!editable"
        />
        <!-- This div is used to keep the buttons in a line despite the flex -->
        <div class="save-asset-file">
          <ButtonControl
            class="save-button"
            :primary="true"
            :label="saveButtonLabel"
            :inline="true"
            :disabled="!editable"
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
import { showRefusal } from "@common/util/show-refusal";
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
// Whether the editor holds the text of the selected profile. It does not
// while the text loads, when the file refused the read, and when the list
// has no profile.
const editable = ref(false);
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

watch(toRef(props, "which"), () => {
  // The other tab shows its first profile.
  showItem(0);
});

watch(currentItem, () => {
  loadDefaultsForState();
});

watch(editorContents, () => {
  if (editorContents.value === lastLoadedEditorContents.value) {
    savingStatus.value = "";
  } else {
    savingStatus.value = trans("Unsaved changes");
  }
});

listProfiles()
  .then(() => showItem(currentItem.value))
  .catch(showRefusal);

const offCallback = ipcRenderer.on("shortcut", (event, shortcut) => {
  if (shortcut === "save-file") {
    saveDefaultsFile();
  }
});
onUnmounted(() => {
  offCallback();
});

/** Puts a text into the editor as the saved text of the selected profile. */
function showText(text: string): void {
  lastLoadedEditorContents.value = text;
  editorContents.value = text;
  savingStatus.value = "";
}

/**
 * Selects the profile at an index of the visible list and loads its text
 * one time: a new selection loads through the watcher.
 */
function showItem(index: number): void {
  const last = visibleItems.value.length - 1;
  const selected = Math.max(0, Math.min(index, last));
  if (currentItem.value === selected) {
    loadDefaultsForState();
  } else {
    currentItem.value = selected;
  }
}

/** The index of a profile in the visible list, and the selected index for a name that is not there. */
function indexOfProfile(name: string | undefined): number {
  const index = visibleItems.value.findIndex((file) => file.name === name);
  return index === -1 ? currentItem.value : index;
}

function loadDefaultsForState(): void {
  // Loads a defaults file from main for the given state (tab + list item)
  const selected = visibleItems.value[currentItem.value];
  if (selected === undefined) {
    showText("");
    editable.value = false;
    currentFilename.value = "";
    return;
  }

  const filename = selected.name;
  const isSelected = (): boolean => visibleItems.value[currentItem.value]?.name === filename;

  ipcRenderer
    .invoke("assets-provider", { command: "get-defaults-file", payload: { filename } })
    .then(
      (data) => {
        // The author selected another profile while this one loaded.
        if (!isSelected()) {
          return;
        }
        showText(data);
        editable.value = true;
        currentFilename.value = filename;
      },
      (failure: Error) => {
        // The window does not have the text of this profile. It shows no
        // text of another profile, and it offers no save.
        if (isSelected()) {
          showText("");
          editable.value = false;
          currentFilename.value = filename;
        }
        showRefusal(failure);
      },
    );
}

/**
 * Reads the list of the defaults files again. The list has only the files
 * of the defaults directory, not the custom profiles of the exporter: this
 * view edits files.
 */
async function listProfiles(): Promise<void> {
  availableDefaultsFiles.value = await ipcRenderer.invoke("assets-provider", {
    command: "list-defaults",
  });
}

/** Reads the list again and shows a profile: the one of a name, or the selected one. */
function retrieveDefaultsFiles(select?: string): void {
  listProfiles()
    .then(() => showItem(indexOfProfile(select)))
    .catch(showRefusal);
}

function saveDefaultsFile(): void {
  const selected = visibleItems.value[currentItem.value];
  if (!editable.value || selected === undefined) {
    return;
  }

  const filename = selected.name;
  const contents = editorContents.value;
  const saved = trans("Saved!");
  savingStatus.value = trans("Saving …");

  ipcRenderer
    .invoke("assets-provider", { command: "set-defaults-file", payload: { filename, contents } })
    .then(
      () => {
        lastLoadedEditorContents.value = contents;
        if (editorContents.value === contents) {
          savingStatus.value = saved;
          setTimeout(() => {
            if (savingStatus.value === saved) {
              savingStatus.value = "";
            }
          }, 1000);
        } else {
          savingStatus.value = trans("Unsaved changes");
        }
        // The saved text can change what the list says of the profile, and
        // whether this tab has it. The editor keeps its text while the
        // profile keeps its place.
        listProfiles()
          .then(() => {
            const index = indexOfProfile(filename);
            if (index !== currentItem.value || visibleItems.value[index]?.name !== filename) {
              showItem(index);
            }
          })
          .catch(showRefusal);
      },
      (failure: Error) => {
        savingStatus.value = trans("Unsaved changes");
        showRefusal(failure);
      },
    );
}

function newDefaultsFile(newName?: string): void {
  // A profile without a name of the author gets a name with the time. A
  // name of the author that a profile has is refused: no profile is
  // replaced.
  const typed = newName === undefined ? "" : newName.trim();
  const dt = DateTime.now();
  const timeString = dt.toISOTime({ includeOffset: false, suppressMilliseconds: true });
  const filename = typed === "" ? `New Profile ${dt.toISODate()} ${timeString}.yaml` : typed;

  ipcRenderer
    .invoke("assets-provider", {
      command: "create-defaults-file",
      payload: { filename, contents: NEW_DEFAULTS_FILE_CONTENTS },
    })
    .then((created) => {
      retrieveDefaultsFiles(created);
    })
    .catch(showRefusal);
}

function renameFile(): void {
  const selected = visibleItems.value[currentItem.value];
  if (selected === undefined) {
    return;
  }

  let newName = currentFilename.value;
  if (!newName.endsWith(".yaml") && !newName.endsWith(".yml")) {
    newName += ".yaml";
  }

  newName = sanitizeFilename(newName, { replacement: "-" });

  ipcRenderer
    .invoke("assets-provider", {
      command: "rename-defaults-file",
      payload: { oldName: selected.name, newName },
    })
    .then(() => {
      retrieveDefaultsFiles(newName);
    })
    .catch(showRefusal);
}

function removeFile(idx: number): void {
  if (idx > visibleItems.value.length - 1 || idx < 0) {
    return;
  }

  const filename = visibleItems.value[idx].name;

  ipcRenderer
    .invoke("assets-provider", { command: "remove-defaults-file", payload: { filename } })
    .then(() => {
      retrieveDefaultsFiles();
    })
    .catch(showRefusal);
}

function openDefaultsDirectory(): void {
  ipcRenderer.invoke("assets-provider", { command: "open-defaults-directory" }).catch(showRefusal);
}
</script>

<style lang="css" scoped>
</style>
