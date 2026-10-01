<template>
  <DialogRoot v-model:open="editing">
    <DialogPortal>
      <DialogOverlay class="ignore-rules-backdrop"></DialogOverlay>
      <DialogContent class="ignore-rules-dialog" data-ignore-rules-dialog>
        <DialogTitle class="ignore-rules-title">{{ trans('File filters') }}</DialogTitle>
        <DialogDescription class="ignore-rules-body">
          {{ trans('A file or folder that a rule matches is not in the file manager, the launcher, search, links or lint. Write one rule on each line.') }}
        </DialogDescription>
        <div class="ignore-rules-sources">
          <label class="ignore-rules-source">
            <span class="ignore-rules-heading">{{ trans('All workspaces') }}</span>
            <textarea
              v-model="globalDraft"
              class="ignore-rules-input"
              rows="5"
              spellcheck="false"
              data-ignore-rules-global
            ></textarea>
          </label>
          <label
            v-for="root in roots"
            v-bind:key="root"
            class="ignore-rules-source"
          >
            <span class="ignore-rules-heading" v-bind:title="root">
              {{ pathBasename(root) }}
              <span class="ignore-rules-file">{{ WORKSPACE_RULES_FILE }}</span>
            </span>
            <textarea
              v-model="workspaceDrafts[root]"
              class="ignore-rules-input"
              rows="5"
              spellcheck="false"
              v-bind:data-ignore-rules-workspace="root"
            ></textarea>
          </label>
        </div>
        <table class="ignore-rules-syntax">
          <tbody>
            <tr v-for="[rule, meaning] in SYNTAX" v-bind:key="rule">
              <td><code>{{ rule }}</code></td>
              <td>{{ meaning }}</td>
            </tr>
          </tbody>
        </table>
        <div class="ignore-rules-actions">
          <DialogClose class="ignore-rules-button">{{ trans('Cancel') }}</DialogClose>
          <button
            class="ignore-rules-button ignore-rules-button-primary"
            data-ignore-rules-save
            v-on:click="save()"
          >
            {{ trans('Save') }}
          </button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        IgnoreRulesDialog
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The editor of the ignore rules: the rules for all
 *                  workspaces and the rules file of each open workspace.
 *                  Save sends each changed text to its owner; the FSAL then
 *                  lists with the new rules.
 *
 * END HEADER
 */

import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle
} from 'reka-ui'
import { trans } from '@common/i18n-renderer'
import showToast from '@common/util/show-toast'
import { reportError } from '@common/util/error-reporting'
import { pathBasename } from '@common/util/renderer-path-polyfill'
import { WORKSPACE_RULES_FILE } from 'source/common/util/ignore-rules'
import { useConfigStore, useIgnoreRulesStore } from 'source/pinia'

const ipcRenderer = window.ipc

const SYNTAX: ReadonlyArray<[rule: string, meaning: string]> = [
  [ '*scripts*', trans('Each file and folder with “scripts” in its name') ],
  [ '*_files/', trans('Each folder with a name that ends in “_files”') ],
  [ 'references/', trans('Each folder with the name “references”') ],
  [ 'AGENTS.md', trans('Each file and folder with the name “AGENTS.md”') ],
  [ '/drafts/old/', trans('The one folder “drafts/old” at the workspace root') ],
  [ '!keep.md', trans('Shows “keep.md” again, but not below a hidden folder') ]
]

const configStore = useConfigStore()
const { sources, editing } = storeToRefs(useIgnoreRulesStore())

const roots = computed(() => [...sources.value.workspaceRules.keys()])
const globalDraft = ref('')
const workspaceDrafts = ref<Record<string, string>>({})

watch(editing, isOpen => {
  if (isOpen) {
    globalDraft.value = sources.value.globalRules.join('\n')
    workspaceDrafts.value = Object.fromEntries(sources.value.workspaceRules)
  }
})

function rulesOf (text: string): string[] {
  return text.split('\n').filter(line => line.trim() !== '')
}

/** The text of a rules file: no text when it holds no line, else one final line end. */
function fileTextOf (draft: string): string {
  const text = draft.replace(/\s+$/, '')
  return text === '' ? '' : `${text}\n`
}

function save (): void {
  const globalRules = rulesOf(globalDraft.value)
  if (globalRules.join('\n') !== sources.value.globalRules.join('\n')) {
    configStore.setConfigValue('fileManager.ignoreRules', globalRules)
  }

  const changed = roots.value
    .map(root => ({ root, text: fileTextOf(workspaceDrafts.value[root]) }))
    .filter(({ root, text }) => text !== fileTextOf(sources.value.workspaceRules.get(root) ?? ''))

  Promise.all(changed.map(async payload => {
    await ipcRenderer.invoke('fsal', { command: 'set-workspace-ignore-rules', payload })
  }))
    .then(() => { editing.value = false })
    .catch(err => {
      reportError('Could not save the ignore rules', err)
      showToast(trans('Could not save the filters: %s', err instanceof Error ? err.message : String(err)), 'error')
    })
}
</script>

<style lang="less">
.ignore-rules-backdrop {
  position: fixed;
  inset: 0;
  background-color: var(--chrome-overlay);
}

.ignore-rules-dialog {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 520px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  padding: 16px;
  border-radius: 8px;
  background-color: var(--chrome-surface);
  box-shadow: var(--chrome-elevation);
  color: var(--chrome-text);
  font-size: var(--chrome-font-size);

  .ignore-rules-title { margin: 0; font-size: 15px; font-weight: 600; }
  .ignore-rules-body { margin: 0; color: var(--chrome-text-muted); }

  .ignore-rules-sources {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
    overflow-y: auto;
  }

  .ignore-rules-source {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .ignore-rules-heading { font-weight: 600; }

  .ignore-rules-file {
    margin-left: 6px;
    font-weight: 400;
    color: var(--chrome-text-muted);
  }

  // Three classes outrank the platform rules for every input in
  // generic.css (body.<platform>.dark textarea).
  .ignore-rules-sources textarea.ignore-rules-input {
    box-sizing: border-box;
    width: 100%;
    margin: 0;
    padding: 6px 8px;
    border: 1px solid var(--chrome-input-border);
    border-radius: 6px;
    background-color: var(--chrome-input-bg);
    color: inherit;
    font-family: monospace;
    font-size: inherit;
    line-height: 1.5;
    resize: vertical;

    &:focus-visible {
      outline: 2px solid var(--chrome-row-accent);
      outline-offset: -1px;
    }
  }

  .ignore-rules-syntax {
    border-collapse: collapse;
    color: var(--chrome-text-muted);

    td { padding: 1px 0; vertical-align: baseline; }
    td:first-child { padding-right: 16px; white-space: nowrap; }
    code { color: var(--chrome-text); font-family: monospace; }
  }

  .ignore-rules-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }

  .ignore-rules-actions button.ignore-rules-button {
    appearance: none;
    margin: 0;
    padding: 5px 12px;
    border: 1px solid var(--chrome-border);
    border-radius: 6px;
    background-color: var(--chrome-surface);
    color: inherit;
    font: inherit;
    cursor: pointer;

    &.ignore-rules-button-primary {
      border-color: transparent;
      background-color: var(--chrome-row-accent);
      color: var(--chrome-row-accent-contrast, white);
    }
  }
}
</style>
