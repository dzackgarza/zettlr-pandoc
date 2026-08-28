/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        useWindowState
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This model manages the state for any given main window, i.e.
 *                  values that represent volatile configuration of the window
 *                  UI or UX without affecting other state managers.
 *
 * END HEADER
 */

import { type WritingTarget } from "@providers/targets";
import { defineStore } from "pinia";
import type { SearchResult } from "source/app/service-providers/search";
import type { DocumentInfo } from "source/common/modules/markdown-editor";
import type { ToCEntry } from "source/common/modules/markdown-editor/plugins/toc-field";
import { computed, type Ref, ref } from "vue";

const ipcRenderer = window.ipc;

/**
 * This interface describes a specific descriptor for use during file searches
 */
export interface FileSearchDescriptor {
  path: string;
  relativeDirectoryPath: string;
  filename: string;
  displayName: string;
}

/**
 * This interface describes a wrapper that combines search results with
 * metadata on the file the results describe. This store holds the search
 * results, so it owns the wrapper contract; GlobalSearch.vue produces and
 * renders it.
 */
export interface SearchResultWrapper {
  key: string;
  file: FileSearchDescriptor;
  result: SearchResult;
  hideResultSet: boolean;
  weight: number;
}

async function updateSnippets(
  snippets: Ref<Array<{ name: string; content: string }>>,
): Promise<void> {
  // Now we have to pair two types of calls to the assets provider to get all
  // snippets: First a call to list all snippets, and then one `get` call to
  // retrieve its file contents.
  const snippetNames = await ipcRenderer.invoke("assets-provider", {
    command: "list-snippets",
  });

  const newSnippets: Array<{ name: string; content: string }> = [];
  for (const snippet of snippetNames) {
    const content = await ipcRenderer.invoke("assets-provider", {
      command: "get-snippet",
      payload: { name: snippet },
    });

    newSnippets.push({ name: snippet, content });
  }

  snippets.value = newSnippets;
}

export const useWindowStateStore = defineStore("window-state", () => {
  const isFullscreen = ref(false);
  const uncollapsedDirectories = ref<string[]>([]);
  const distractionFreeMode = ref<undefined | string>(undefined);
  const activeDocumentInfo = ref<undefined | DocumentInfo>(undefined);
  const tableOfContents = ref<ToCEntry[] | undefined>(undefined);
  const snippets = ref<Array<{ name: string; content: string }>>([]);
  const writingTargets = ref<WritingTarget[]>([]);

  /**
   * SEARCH RESULTS FUNCTIONALITY
   */
  const searchResults = ref<SearchResultWrapper[]>([]);
  const maxSearchResultWeight = computed(() => {
    const allWeights = searchResults.value.map((r) => r.weight);
    return Math.max(...allWeights);
  });

  function addSearchResult(result: SearchResultWrapper) {
    searchResults.value.push(result);
    searchResults.value.sort((a, b) => b.weight - a.weight);
  }

  // Snippets
  ipcRenderer.on("assets-provider", (event, what: string) => {
    if (what === "snippets-updated") {
      updateSnippets(snippets).catch((e) => console.error(e));
    }
  });

  updateSnippets(snippets).catch((e) => console.error(e));

  // Writing targets
  ipcRenderer.on("targets-provider", (event, what: string) => {
    if (what === "writing-targets-updated") {
      ipcRenderer
        .invoke("targets-provider", { command: "get-targets" })
        .then((targets: WritingTarget[]) => {
          writingTargets.value = targets;
        })
        .catch((e) => console.error(e));
    }
  });

  ipcRenderer
    .invoke("targets-provider", { command: "get-targets" })
    .then((targets: WritingTarget[]) => {
      writingTargets.value = targets;
    })
    .catch((e) => console.error(e));

  ipcRenderer.on("window-controls", (event, { command, payload }) => {
    if (command === "fullscreen" && typeof payload === "boolean") {
      isFullscreen.value = payload;
    }
  });

  return {
    uncollapsedDirectories,
    distractionFreeMode,
    activeDocumentInfo,
    tableOfContents,
    searchResults,
    addSearchResult,
    maxSearchResultWeight,
    snippets,
    writingTargets,
    isFullscreen,
  };
});
