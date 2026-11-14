<template>
  <WorkspaceEditPreviewDialog
    v-if="current !== undefined"
    v-bind:key="current.id"
    v-bind:title="current.title"
    v-bind:description="current.description"
    v-bind:documents="current.documents"
    v-on:apply="answer('apply-workspace-edit')"
    v-on:cancel="answer('discard-workspace-edit')"
  ></WorkspaceEditPreviewDialog>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        WorkspaceEditProposals
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Shows each proposal that the main process sends to this
 *                  window (a move retargets links, a tag rename changes
 *                  tags) in the preview dialog, one after the other, and
 *                  sends the answer of the author. The application shows a
 *                  failure of the answer in this window.
 *
 * END HEADER
 */

import { reportError } from "@common/util/error-reporting";
import {
  WORKSPACE_EDIT_PROPOSAL_CHANNEL,
  type WorkspaceEditProposal,
} from "@dts/common/workspace-edit";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import WorkspaceEditPreviewDialog from "./WorkspaceEditPreviewDialog.vue";

const ipcRenderer = window.ipc;

const waiting = ref<WorkspaceEditProposal[]>([]);
const current = computed<WorkspaceEditProposal | undefined>(() => waiting.value[0]);

function receive(_event: unknown, proposal: WorkspaceEditProposal): void {
  waiting.value.push(proposal);
}

function answer(command: "apply-workspace-edit" | "discard-workspace-edit"): void {
  const proposal = waiting.value.shift();
  if (proposal === undefined) {
    return;
  }
  ipcRenderer
    .invoke("application", { command, payload: { id: proposal.id } })
    .catch((failure: Error) => reportError(failure));
}

let stopListening: (() => void) | undefined;
onMounted(() => {
  stopListening = ipcRenderer.on(WORKSPACE_EDIT_PROPOSAL_CHANNEL, receive);
});
onBeforeUnmount(() => stopListening?.());
</script>
