<template>
  <AlertDialogRoot v-model:open="open">
    <AlertDialogPortal>
      <AlertDialogOverlay class="fix-all-backdrop"></AlertDialogOverlay>
      <AlertDialogContent class="fix-all-dialog" data-fix-all-dialog>
        <AlertDialogTitle class="fix-all-title">{{ title }}</AlertDialogTitle>
        <AlertDialogDescription class="fix-all-body" data-fix-all-summary>{{ summary }}</AlertDialogDescription>
        <template v-if="plan !== undefined && fixCount > 0">
          <table class="fix-all-rules" data-fix-all-rules>
            <thead>
              <tr><th>{{ trans('Rule') }}</th><th class="fix-all-count">{{ trans('Fixes') }}</th></tr>
            </thead>
            <tbody>
              <tr v-for="[rule, count] in ruleCounts" v-bind:key="rule">
                <td><code>{{ rule }}</code></td>
                <td class="fix-all-count">{{ count }}</td>
              </tr>
            </tbody>
          </table>
          <p class="fix-all-heading">{{ trans('Documents') }}</p>
          <ul class="fix-all-documents" data-fix-all-documents>
            <li
              v-for="document in plan.documents"
              v-bind:key="document.documentPath"
              v-bind:title="document.documentPath"
            >
              {{ pathBasename(document.documentPath) }}
              <span class="fix-all-count">{{ document.edits.length }}</span>
            </li>
          </ul>
        </template>
        <p v-if="plan !== undefined && plan.unlinted.length > 0" class="fix-all-body" data-fix-all-unlinted>
          {{ trans('Flowmark could not lint %s; they stay as they are.', documentsPhrase(plan.unlinted.length)) }}
        </p>
        <div class="fix-all-actions">
          <AlertDialogCancel class="fix-all-button">{{ fixCount > 0 ? trans('Cancel') : trans('Close') }}</AlertDialogCancel>
          <AlertDialogAction
            v-if="fixCount > 0"
            class="fix-all-button fix-all-button-primary"
            data-fix-all-confirm
            v-on:click="commit()"
          >{{ trans('Fix') }}</AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        FixAllDialog
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The confirmation of Fix All. It asks the main process for
 *                  the plan of a scope, shows how many fixes change how many
 *                  documents, per rule and per document, and commits that
 *                  same plan when the user confirms.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import { reportError } from "@common/util/error-reporting";
import { pathBasename } from "@common/util/renderer-path-polyfill";
import showToast from "@common/util/show-toast";
import type { FixAllPlan, FixAllRequest } from "@dts/common/fix-all";
import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle,
} from "reka-ui";
import { computed, ref, shallowRef } from "vue";

const ipcRenderer = window.ipc;

const open = ref(false);
const request = shallowRef<FixAllRequest | undefined>(undefined);
const plan = shallowRef<FixAllPlan | undefined>(undefined);

const fixCount = computed(
  () => plan.value?.documents.reduce((sum, document) => sum + document.edits.length, 0) ?? 0,
);

const ruleCounts = computed(() => {
  const counts = new Map<string, number>();
  for (const edit of plan.value?.documents.flatMap((document) => document.edits) ?? []) {
    counts.set(edit.rule, (counts.get(edit.rule) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
});

const title = computed(() => {
  switch (request.value?.scope) {
    case "document":
      return trans("Fix all in the document");
    case "open":
      return trans("Fix all in open documents");
    default:
      return trans("Fix all in the workspace");
  }
});

function fixesPhrase(count: number): string {
  return count === 1 ? trans("1 fix") : trans("%s fixes", count);
}

function documentsPhrase(count: number): string {
  return count === 1 ? trans("1 document") : trans("%s documents", count);
}

const summary = computed(() => {
  if (plan.value === undefined) {
    return trans("Finding fixes…");
  }
  if (fixCount.value === 0) {
    return trans("No auto-fixable issues in %s.", documentsPhrase(plan.value.documentsChecked));
  }
  return trans(
    "Apply %s to %s of %s? Every fix keeps the meaning of the text.",
    fixesPhrase(fixCount.value),
    plan.value.documents.length,
    documentsPhrase(plan.value.documentsChecked),
  );
});

/** Opens the dialog on a scope and asks the main process for its plan. */
function start(scope: FixAllRequest): void {
  request.value = scope;
  plan.value = undefined;
  open.value = true;
  ipcRenderer
    .invoke("application", { command: "preview-fix-all", payload: scope })
    .then((result) => {
      if (request.value === scope) {
        plan.value = result;
      }
    })
    .catch((error) => {
      open.value = false;
      reportError(error);
    });
}

function commit(): void {
  const committed = plan.value;
  if (committed === undefined) {
    return;
  }
  ipcRenderer
    .invoke("application", { command: "commit-fix-all", payload: { plan: committed } })
    .then((outcome) => {
      if (outcome.status === "conflict") {
        showToast(
          trans(
            "%s changed after the fixes were found. Nothing was changed; run Fix All again.",
            pathBasename(outcome.documentPath),
          ),
          "error",
        );
        return;
      }
      showToast(
        trans(
          "Applied %s to %s.",
          fixesPhrase(outcome.fixesApplied),
          documentsPhrase(outcome.documentsChanged.length),
        ),
      );
    })
    .catch((error) => {
      reportError(error);
    });
}

defineExpose({ start });
</script>

<style lang="less">
.fix-all-backdrop {
  position: fixed;
  inset: 0;
  background-color: rgba(0, 0, 0, 0.35);
}

.fix-all-dialog {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 420px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  padding: 16px;
  border: 1px solid var(--chrome-border);
  border-radius: 8px;
  background-color: var(--chrome-surface);
  color: inherit;
  font-size: 12px;

  .fix-all-title { margin: 0; font-size: 13px; font-weight: 600; }
  .fix-all-body { margin: 0; opacity: 0.8; }
  .fix-all-count { text-align: right; opacity: 0.7; font-variant-numeric: tabular-nums; }
  .fix-all-heading, th { margin: 0; font-weight: 600; text-align: left; opacity: 0.7; }

  .fix-all-rules {
    border-collapse: collapse;
    td { padding: 1px 4px; }
  }

  .fix-all-documents {
    margin: 0;
    padding: 0;
    list-style: none;
    overflow-y: auto;
    max-height: 160px;
    border-top: 1px solid var(--chrome-border);

    li {
      display: flex;
      justify-content: space-between;
      padding: 2px 4px;
    }
  }

  .fix-all-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }

  button.fix-all-button {
    appearance: none;
    margin: 0;
    padding: 5px 10px;
    border: 1px solid var(--chrome-border);
    border-radius: 6px;
    background-color: var(--chrome-surface);
    color: inherit;
    font: inherit;
    cursor: pointer;

    &.fix-all-button-primary {
      border-color: transparent;
      background-color: var(--chrome-row-accent);
      color: var(--chrome-row-accent-contrast, white);
    }
  }
}
</style>
