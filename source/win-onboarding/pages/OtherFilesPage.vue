<template>
  <h1>{{ pageHeading }}</h1>

  <p>
    {{ previewInfo }}
  </p>

  <p>
    <button v-bind:class="{ active: hasActivatedPreviws }" v-on:click="togglePreviews">
      {{ activateLabel }}
    </button>
  </p>
</template>

<script setup lang="ts">
import { trans } from "source/common/i18n-renderer";
import { useConfigStore } from "source/pinia";
import { computed } from "vue";

const configStore = useConfigStore();

const pageHeading = trans("Images and PDFs in Zettlr");
const previewInfo = trans(
  "Preview images and PDFs inside Zettlr while you write. If disabled, they open in your computer's default viewer.",
);
const activateLabel = trans("Preview images and PDFs in Zettlr");

// Which files the file manager lists belongs to the File filters window; this
// page decides only where images and PDFs open.
const hasActivatedPreviws = computed(() => {
  return (
    configStore.config.files.images.openWith === "zettlr" &&
    configStore.config.files.pdf.openWith === "zettlr"
  );
});

function togglePreviews() {
  const openWith = hasActivatedPreviws.value ? "system" : "zettlr";
  configStore.setConfigValue("files.images.openWith", openWith);
  configStore.setConfigValue("files.pdf.openWith", openWith);
}
</script>

<style lang="css" scoped>
</style>
