<template>
  <h1>{{ pageHeading }}</h1>

  <p>
    {{ renderingModeIntro }}
  </p>

  <p class="flex-buttons">
    <button
      v-bind:class="{ active: renderingMode === 'preview' }"
      v-on:click="renderingMode = 'preview'"
    >
      WYSIWYG
    </button>
    <button
      v-bind:class="{ active: renderingMode === 'raw'}"
      v-on:click="renderingMode = 'raw'"
    >
      {{ rawLabel }}
    </button>
  </p>

  <p>
    {{ autosaveIntro }}
  </p>

  <p class="box">
    <RadioControl
      v-model="autosave"
      name="autosave"
      v-bind:options="autoSaveChoices()"
    ></RadioControl>
  </p>
</template>

<script setup lang="ts">
import { trans } from "source/common/i18n-renderer";
import { autoSaveChoices } from "source/common/util/setting-choices";
import RadioControl from "source/common/vue/form/elements/RadioControl.vue";
import { ref, watch } from "vue";

const pageHeading = trans("Writing Markdown");
const renderingModeIntro = trans(
  "The core of Zettlr is writing Markdown, which can be shown using either its raw syntax, or in a WYSIWYG mode. Which one do you prefer?",
);
const rawLabel = trans("Raw Syntax");
const autosaveIntro = trans(
  "Some people prefer an app automatically saving your work; others want to manually save. Which do you prefer?",
);

const renderingMode = ref(window.config.get("display.renderingMode") as "preview" | "raw");
const autosave = ref(window.config.get("editor.autoSave") as "off" | "immediately" | "delayed");

watch(renderingMode, () => {
  window.config.set("display.renderingMode", renderingMode.value);
});

watch(autosave, () => {
  window.config.set("editor.autoSave", autosave.value);
});
</script>

<style lang="less">
p.flex-buttons {
  display: flex;
  justify-content: center;
  gap: 10px;
}
</style>
