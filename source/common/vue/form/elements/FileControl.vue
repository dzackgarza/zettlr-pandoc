<template>
  <div class="form-control">
    <label v-if="label" v-bind:for="fieldID">{{ label }}</label>
    <div class="input-button-group">
      <TextControl
        v-model="textValue"
        v-bind:name="name"
        v-bind:placeholder="placeholder"
        v-bind:reset="reset"
        v-bind:style="'flex-grow: 1;'"
      ></TextControl>
      <button
        type="button"
        class="request-file"
        v-on:click="(directory) ? requestDir() : requestFile()"
      >
        {{ selectButtonLabel }}
      </button>
    </div>
    <ZtrAdmonition
      v-if="problem !== undefined"
      class="file-problem"
      role="alert"
      v-bind:type="'error'"
    >
      {{ problem }}
    </ZtrAdmonition>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        File
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This component represents a custom file input.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import { reportError } from "@common/util/error-reporting";
import type { FileFilter } from "electron";
import type { RequestFilesIPCAPI } from "source/app/service-providers/windows";
import { computed, ref, toRef, watch } from "vue";
import ZtrAdmonition from "../../ZtrAdmonition.vue";
import TextControl from "./TextControl.vue";

const ipcRenderer = window.ipc;

const props = defineProps<{
  modelValue: string;
  label?: string;
  name?: string;
  reset?: boolean | string;
  placeholder?: string;
  directory?: boolean;
  filter?: FileFilter[];
  /** Why the app could not use the file that the value names. */
  problem?: string;
}>();

const emit = defineEmits<(e: "update:modelValue", val: string) => void>();

const textValue = ref<string>(props.modelValue);

const fieldID = computed<string>(() => {
  return "field-input-" + props.name;
});

const selectButtonLabel = computed<string>(() => {
  return props.directory ? trans("Select folder…") : trans("Select file…");
});

watch(toRef(props, "modelValue"), (newValue) => {
  if (newValue !== textValue.value) {
    textValue.value = newValue;
  }
});

watch(textValue, () => {
  emit("update:modelValue", textValue.value);
});

function requestFile(): void {
  const payload: RequestFilesIPCAPI = {
    filters: props.filter ?? [{ name: trans("All Files"), extensions: ["*"] }],
    multiSelection: false,
  };

  ipcRenderer
    .invoke("request-files", payload)
    .then((result) => {
      // Don't update to empty paths.
      if (result.length === 0 || result[0].trim() === "") {
        return;
      }

      // Write the return value into the data-request-target of the clicked
      // button, because each button has a designated text field.
      textValue.value = result[0];
    })
    .catch((e) => reportError(e));
}

function requestDir(): void {
  ipcRenderer
    .invoke("request-dir")
    .then((result) => {
      // Don't update to empty paths.
      if (result.length === 0 || result[0].trim() === "") {
        return;
      }

      textValue.value = result[0];
    })
    .catch((e) => reportError(e));
}
</script>

<style lang="less">
body {
  .form-control .input-button-group {
    display: grid;
    column-gap: 10px;
    grid-template-columns: auto 100px;
    margin: 10px 0;

    input, button { white-space: nowrap; }

    button {
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }

  // The cause can be a long path without a space.
  .form-control .file-problem {
    overflow-wrap: anywhere;
    user-select: text;
  }
}
body.darwin {
  label {
    font-family: system-ui, sans-serif;
  }
}
</style>
