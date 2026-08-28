<template>
  <div
    id="references-panel"
    role="tabpanel"
  >
    <!-- References -->
    <h1>
      {{ referencesLabel }}
      <small
        v-if="bibliography !== undefined && bibliography[1].length > 0"
        class="word-count"
      >
        {{ wordCountLabel }}
      </small>
    </h1>
    <!-- eslint-disable vue/no-v-html -- referenceHTML is sanitized by DOMPurify before insertion. -->
    <div
      id="references-list"
      v-html="referenceHTML"
    />
    <!-- eslint-enable vue/no-v-html -->
  </div>
</template>

<script setup lang="ts">
import { trans } from "@common/i18n-renderer";
import { getBibliographyForDescriptor as getBibliography } from "@common/util/get-bibliography-for-descriptor";
import { isAbsolutePath, resolvePath } from "@common/util/renderer-path-polyfill";
import { CITEPROC_MAIN_DB } from "@dts/common/citeproc";
import { DP_EVENTS } from "@dts/common/documents";
import { type AnyDescriptor, type MDFileDescriptor } from "@dts/common/fsal";
import type { CiteprocProviderIPCAPI } from "source/app/service-providers/citeproc";
import { type DocumentsUpdateContext } from "source/app/service-providers/documents";
import { hasMarkdownExt } from "source/common/util/file-extention-checks";
import localiseNumber from "source/common/util/localise-number";
import { useDocumentTreeStore } from "source/pinia";
import { computed, onMounted, ref, watch } from "vue";

const ipcRenderer = window.ipc;
const documentTreeStore = useDocumentTreeStore();

// This function overwrites the getBibliographyForDescriptor function to ensure
// the library is always absolute. We have to do it this ridiculously since the
// function is called in both main and renderer processes, and we still have the
// issue that path-browserify is entirely unusable.
function getBibliographyForDescriptor(descriptor: MDFileDescriptor): string {
  const library = getBibliography(descriptor);

  if (library !== CITEPROC_MAIN_DB && !isAbsolutePath(library)) {
    return resolvePath(descriptor.dir, library);
  } else {
    return library;
  }
}

const bibliography = ref<[BibliographyOptions, string[]] | undefined>(undefined);

const referencesLabel = trans("References");
const activeFile = computed(() => documentTreeStore.lastLeafActiveFile);

/**
 * Takes the bibliography and returns a renderable HTML representation of it
 *
 * @return  {string}  The HTML contents as a string
 */
const referenceHTML = computed(() => {
  if (bibliography.value === undefined || bibliography.value[1].length === 0) {
    return `<p>${trans("There are no citations in this document.")}</p>`;
  }

  const bibHTML = [
    bibliography.value[0].bibstart,
    ...bibliography.value[1],
    bibliography.value[0].bibend,
  ].join("\n");

  return bibHTML;
});

// Provides an approximate word count. This can be used to, e.g., gauge how many
// words the list of references will contain, which can be important if a there
// is a limit that includes the bibliography that needs to be maintained.
const approximateWordCount = computed(() => {
  if (bibliography.value === undefined) {
    return 0;
  }

  return bibliography.value[1].map((x) => x.split(/\s+/g).length).reduce((p, c) => p + c, 0);
});

const wordCountLabel = computed(() =>
  trans("circa %s words", localiseNumber(approximateWordCount.value)),
);

watch(activeFile, () => {
  updateBibliography().catch((e) => console.error("Could not update bibliography", e));
});

onMounted(() => {
  ipcRenderer.on(
    "documents-update",
    (e, payload: { event: DP_EVENTS; context: DocumentsUpdateContext }) => {
      const { event, context } = payload;
      // Update the bibliography if the active file has been saved
      if (event === DP_EVENTS.FILE_SAVED) {
        const { filePath } = context;

        if (filePath === activeFile.value?.path) {
          updateBibliography().catch((e) => console.error("Could not update bibliography", e));
        }
      }
    },
  );

  // Initial bibliography update
  updateBibliography().catch((e) => console.error("Could not update bibliography", e));
});

/**
 * Updates the bibliography displayed in the sidebar based on the current
 * active file.
 */
async function updateBibliography(): Promise<void> {
  if (activeFile.value === undefined) {
    bibliography.value = undefined;
    return;
  }

  if (!hasMarkdownExt(activeFile.value.path)) {
    return;
  }

  const descriptor: AnyDescriptor | undefined = await ipcRenderer.invoke("fsal", {
    command: "get-descriptor",
    payload: activeFile.value.path,
  });

  if (descriptor === undefined || descriptor.type !== "file") {
    bibliography.value = undefined;
    return;
  }

  const keys = descriptor.citekeys;

  // Now also include potential nocite citations (see https://pandoc.org/MANUAL.html#including-uncited-items-in-the-bibliography)
  const frontmatter = descriptor.frontmatter as { nocite?: unknown } | null | undefined;
  if (frontmatter?.nocite !== undefined) {
    const rawNocite = frontmatter.nocite;
    let nocite: string[] = [];

    if (Array.isArray(rawNocite) && rawNocite.every((e): e is string => typeof e === "string")) {
      nocite = rawNocite.map((e) => e.replace("@", "").trim());
    } else if (typeof rawNocite === "string" && rawNocite.includes(",")) {
      nocite = rawNocite.split(",").map((e) => e.replace("@", "").trim());
    }

    keys.push(...nocite);
  }

  bibliography.value = await ipcRenderer.invoke("citeproc-provider", {
    command: "get-bibliography",
    payload: {
      database: getBibliographyForDescriptor(descriptor),
      citations: [...new Set(keys)],
    },
  } as Extract<CiteprocProviderIPCAPI, { command: "get-bibliography" }>);
}
</script>

<style lang="css">
div#references-panel h1 {
  display: flex;
  gap: 4px;
  align-items: center;
  justify-content: space-between;

  small.word-count {
    font-size: 70%;
    font-style: italic;
    text-align: right;
  }
}

div#references-list div.csl-bib-body {
  div.csl-entry {
    display: list-item;
    list-style-type: square;
    margin: 1em 0.2em 1em 1.8em;
    font-size: 80%;
    user-select: text;
    cursor: text;

    a { color: var(--blue-0); }
  }
  
}
</style>
