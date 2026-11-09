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

const hasActivatedPreviws = computed(() => {
  return (
    configStore.config.files.images.openWith === "zettlr" &&
    configStore.config.files.pdf.openWith === "zettlr"
  );
});

function togglePreviews() {
  if (hasActivatedPreviws.value) {
    configStore.setConfigValue("files.images", { openWith: "system" });
    configStore.setConfigValue("files.pdf", { openWith: "system" });
  } else {
    configStore.setConfigValue("files.images", { openWith: "zettlr" });
    configStore.setConfigValue("files.pdf", { openWith: "zettlr" });
  }
}
</script>

<style lang="css" scoped>
</style>
