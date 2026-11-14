/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        useTagsStore
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This model manages tags
 *
 * END HEADER
 */

import { reportError } from "@common/util/error-reporting";
import { defineStore } from "pinia";
import type { ColoredTag, TagRecord } from "source/app/service-providers/tags";
import { ref } from "vue";

const ipcRenderer = window.ipc;

export const useTagsStore = defineStore("tags", () => {
  const coloredTags = ref<ColoredTag[]>([]);
  const tags = ref<TagRecord[]>([]);

  // Listen to subsequent changes
  ipcRenderer.on("tag-provider", (event, ...message) => {
    if (message[0] === "colored-tags-updated") {
      coloredTags.value = message[1];
    } else {
      tags.value = message[1];
    }
  });

  ipcRenderer
    .invoke("tag-provider", { command: "get-colored-tags" })
    .then((t: ColoredTag[]) => {
      coloredTags.value = t;
    })
    .catch((err) => reportError(err));

  ipcRenderer
    .invoke("tag-provider", { command: "get-all-tags" })
    .then((t: TagRecord[]) => {
      tags.value = t;
    })
    .catch((err) => reportError(err));

  return { coloredTags, tags };
});
