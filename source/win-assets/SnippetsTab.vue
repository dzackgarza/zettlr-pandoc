<template>
  <div class="asset-container">
    <ZtrAdmonition
      type="info"
      class="asset-admonition"
    >
      {{ snippetsExplanation }}
      <br>
      <code>{{ sourcePath }}</code>
    </ZtrAdmonition>
    <CodeEditor
      ref="codeEditor"
      v-model="editorContents"
      :mode="'jsonc'"
      :readonly="sourcePath === ''"
    />
    <div class="save-asset-file">
      <ButtonControl
        :label="openSnippetFileLabel"
        :inline="true"
        :disabled="sourcePath === ''"
        @click="openSnippetsFile"
      />
      <ButtonControl
        :primary="true"
        :label="saveButtonLabel"
        :inline="true"
        :disabled="sourcePath === '' || (codeEditor != null && codeEditor.isClean())"
        @click="saveSnippet()"
      />
      <span
        v-if="savingStatus !== ''"
        class="saving-status"
      >{{ savingStatus }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Snippets
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Edits the configured portable VS Code `.code-snippets` file.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import { showRefusal } from "@common/util/show-refusal";
import CodeEditor from "@common/vue/CodeEditor.vue";
import ButtonControl from "@common/vue/form/elements/ButtonControl.vue";
import ZtrAdmonition from "source/common/vue/ZtrAdmonition.vue";
import { onUnmounted, ref, watch } from "vue";

const ipcRenderer = window.ipc;

interface CodeEditorAPI {
  isClean: () => boolean;
  markClean: () => void;
}
const codeEditor = ref<CodeEditorAPI | null>(null);

const saveButtonLabel = trans("Save");
const openSnippetFileLabel = trans("Open snippet file");
const snippetsExplanation = trans(
  "Edit the .code-snippets file selected in Preferences → Snippets.",
);

const sourcePath = ref("");
const editorContents = ref("");
const savingStatus = ref("");

watch(editorContents, () => {
  if (codeEditor.value != null && codeEditor.value.isClean()) {
    savingStatus.value = "";
  } else {
    savingStatus.value = trans("Unsaved changes");
  }
});

loadSource();

const offShortcut = ipcRenderer.on("shortcut", (_event, shortcut) => {
  if (shortcut === "save-file") {
    saveSnippet();
  }
});

const offAssets = ipcRenderer.on("assets-provider", (_event, what) => {
  if (what === "snippets-updated" && (codeEditor.value == null || codeEditor.value.isClean())) {
    loadSource();
  }
});

onUnmounted(() => {
  offShortcut();
  offAssets();
});

function loadSource(): void {
  ipcRenderer.invoke("assets-provider", { command: "get-snippets-source" }).then(
    (source) => {
      sourcePath.value = source.filePath;
      editorContents.value = source.contents;
      codeEditor.value?.markClean();
      savingStatus.value = "";
    },
    (failure: Error) => {
      // The window does not have the text of the file. It shows none, and
      // it offers no save.
      sourcePath.value = "";
      editorContents.value = "";
      codeEditor.value?.markClean();
      savingStatus.value = "";
      showRefusal(failure);
    },
  );
}

function saveSnippet(): void {
  if (sourcePath.value === "") {
    return;
  }

  const contents = editorContents.value;
  const saved = trans("Saved!");
  savingStatus.value = trans("Saving …");

  ipcRenderer
    .invoke("assets-provider", { command: "set-snippets-source", payload: { contents } })
    .then(
      (result) => {
        // A text that is no snippet file is not written. The status has
        // the diagnostic of the parser.
        if (!result.ok) {
          savingStatus.value = result.error;
          return;
        }
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

function openSnippetsFile(): void {
  ipcRenderer.invoke("assets-provider", { command: "open-snippets-file" }).catch(showRefusal);
}
</script>

<style lang="css" scoped>
code {
  user-select: text;
}
</style>
