<template>
  <div id="references-panel">
    <p
      v-if="bibliography !== undefined && bibliography[1].length > 0"
      class="references-word-count"
    >
      {{ wordCountLabel }}
    </p>
    <p
      v-if="failure !== undefined"
      class="references-failure"
      role="alert"
    >
      {{ failure }}
    </p>
    <!-- eslint-disable vue/no-v-html -- referenceHTML is sanitized by DOMPurify before insertion. -->
    <div
      v-else
      id="references-list"
      v-html="referenceHTML"
    />
    <!-- eslint-enable vue/no-v-html -->
  </div>
</template>

<script setup lang="ts">
import { trans } from "@common/i18n-renderer";
import { citationProblemMessage, followCitationProblems } from "@common/util/citation-problems";
import { documentCitationDatabase } from "@common/util/document-citation-database";
import { reportError } from "@common/util/error-reporting";
import { uncitedItems } from "@common/util/nocite";
import type { CitationResourceProblem } from "@dts/common/citeproc";
import { DP_EVENTS } from "@dts/common/documents";
import { hasMarkdownExt } from "source/common/util/file-extention-checks";
import localiseNumber from "source/common/util/localise-number";
import { useDocumentTreeStore } from "source/pinia";
import { computed, onMounted, ref, watch } from "vue";

const ipcRenderer = window.ipc;
const documentTreeStore = useDocumentTreeStore();

const bibliography = ref<[BibliographyOptions, string[]] | undefined>(undefined);
// Why the provider gave no bibliography for the active file
const bibliographyFailure = ref<string | undefined>(undefined);
// The citation style that the provider could not load: no bibliography exists
const styleProblem = ref<CitationResourceProblem | undefined>(undefined);

// The provider names a style that did not load in the words of the other
// windows. The rejection of the request names the same cause behind the text
// that the IPC layer puts before it.
const failure = computed(() =>
  styleProblem.value !== undefined
    ? citationProblemMessage(styleProblem.value)
    : bibliographyFailure.value,
);

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

/**
 * Shows the bibliography of the active file, or the cause when the provider
 * gives none. A bibliography of an earlier request is not the one of this one.
 */
function refreshBibliography(): void {
  updateBibliography().then(
    () => {
      bibliographyFailure.value = undefined;
    },
    (cause: unknown) => {
      reportError("Could not update bibliography", cause);
      bibliography.value = undefined;
      bibliographyFailure.value = trans(
        "The references could not be rendered: %s",
        cause instanceof Error ? cause.message : String(cause),
      );
    },
  );
}

watch(activeFile, refreshBibliography);

onMounted(() => {
  // The library or the style changed: the bibliography on screen is of the old one.
  ipcRenderer.on("citeproc-database-updated", refreshBibliography);
  followCitationProblems((problems) => {
    styleProblem.value = problems.find((problem) => problem.resource === "style");
  });

  ipcRenderer.on("documents-update", (e, payload) => {
    const { event, context } = payload;
    // Update the bibliography if the active file has been saved
    if (event === DP_EVENTS.FILE_SAVED) {
      const { filePath } = context;

      if (filePath === activeFile.value?.path) {
        refreshBibliography();
      }
    }
  });

  // Initial bibliography update
  refreshBibliography();
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

  const descriptor = await ipcRenderer.invoke("fsal", {
    command: "get-descriptor",
    payload: activeFile.value.path,
  });

  if (descriptor.type !== "file") {
    bibliography.value = undefined;
    return;
  }

  const database = await documentCitationDatabase(descriptor.path);
  const uncited = uncitedItems(descriptor.frontmatter?.nocite);
  const keys = [...descriptor.citekeys, ...uncited.keys];
  if (uncited.all) {
    const items: CSLItem[] = await ipcRenderer.invoke("citeproc-provider", {
      command: "get-items",
      payload: { database },
    });
    keys.push(...items.map((item) => item.id));
  }

  bibliography.value = await ipcRenderer.invoke("citeproc-provider", {
    command: "get-bibliography",
    payload: { database, citations: [...new Set(keys)] },
  });
}
</script>

<style lang="css">
div#references-panel {
  height: 100%;
  overflow-y: auto;
  padding: 0 var(--chrome-inset);
  box-sizing: border-box;
  font-size: var(--chrome-font-size);
}

div#references-panel .references-failure {
  margin: 8px 0;
  color: var(--red-0);
  overflow-wrap: anywhere;
  user-select: text;
}

div#references-panel .references-word-count {
  margin: 4px 0;
  color: var(--chrome-text-muted);
  font-size: var(--chrome-section-font-size);
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
