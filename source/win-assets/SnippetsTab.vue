<template>
  <SplitView
    :initial-size-percent="[ 20, 80 ]"
    :minimum-size-percent="[ 20, 20 ]"
    :reset-size-percent="[ 20, 80 ]"
    :split="'horizontal'"
    :initial-total-width="100"
  >
    <template #view1>
      <div class="asset-container-list">
        <SelectableList
          :items="availableSnippets"
          :selected-item="currentItem"
          :editable="true"
          :add-text-item="true"
          @add="addSnippet($event)"
          @select="currentItem = $event"
          @remove="removeSnippet($event)"
        />
        <ButtonControl
          :label="openSnippetsFolderLabel"
          :inline="false"
          @click="openSnippetsDirectory"
        />
      </div>
    </template>
    <template #view2>
      <div class="asset-container">
        <ZtrAdmonition
          type="info"
          class="asset-admonition"
        >
          {{ snippetsExplanation }}
        </ZtrAdmonition>
        <template v-if="currentItem < 0">
          <ZtrAdmonition
            type="warning"
            class="asset-admonition"
          >
            {{ noSnippetsMessage }}
          </ZtrAdmonition>
        </template>
        <template v-else>
          <p class="asset-input">
            <TextControl
              v-model="currentSnippetText"
              class="asset-input-name"
              :inline="false"
              :disabled="currentItem < 0"
              @confirm="renameSnippet()"
            />
            <ButtonControl
              class="asset-input-button"
              :label="renameSnippetLabel"
              :inline="true"
              :disabled="availableSnippets.length === 0 || currentSnippetText === availableSnippets[currentItem]"
              @click="renameSnippet()"
            />
          </p>
          <CodeEditor
            ref="codeEditor"
            v-model="editorContents"
            :mode="'markdown-snippets'"
            :readonly="currentItem < 0"
          />
          <!-- This div is used to keep the buttons in a line despite the flex -->
          <div class="save-asset-file">
            <ButtonControl
              :primary="true"
              :label="saveButtonLabel"
              :inline="true"
              :disabled="currentItem < 0 || (codeEditor != null && codeEditor.isClean())"
              @click="saveSnippet()"
            />
            <span
              v-if="savingStatus !== ''"
              class="saving-status"
            >{{ savingStatus }}</span>
          </div>
        </template>
      </div>
    </template>
  </SplitView>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Defaults
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This is the defaults file editor view. It allows users to
 *                  modify the provided defaults files.
 *
 * END HEADER
 */

import SplitView from '@common/vue/window/SplitView.vue'
import SelectableList from '@common/vue/form/elements/SelectableList.vue'
import ButtonControl from '@common/vue/form/elements/ButtonControl.vue'
import TextControl from '@common/vue/form/elements/TextControl.vue'
import CodeEditor from '@common/vue/CodeEditor.vue'
import { trans } from '@common/i18n-renderer'
import { ref, watch, onUnmounted } from 'vue'
import ZtrAdmonition from 'source/common/vue/ZtrAdmonition.vue'

const ipcRenderer = window.ipc

// The mounted CodeEditor instance. The previous code called
// CodeEditor.value on the imported component object, which is always
// undefined at runtime, so markClean()/isClean() never ran.
// NOTE: This mirrors CodeEditor.vue's defineExpose surface; the SFC's own
// instance type is not resolvable from here.
interface CodeEditorAPI { isClean: () => boolean, markClean: () => void }
const codeEditor = ref<CodeEditorAPI | null>(null)

const noSnippetsMessage = trans('No snippet selected.')
const saveButtonLabel = trans('Save')
const renameSnippetLabel = trans('Rename snippet')
const snippetsExplanation = trans('Snippets let you define reusable pieces of text with variables.')
const openSnippetsFolderLabel = trans('Open snippets folder')

const currentItem = ref(-1)
const currentSnippetText = ref('')
const editorContents = ref('')
const savingStatus = ref('')
const availableSnippets = ref<string[]>([])

watch(currentItem, () => {
  loadState()
})

watch(editorContents, () => {
  if (codeEditor.value != null && codeEditor.value.isClean()) {
    savingStatus.value = ''
  } else {
    savingStatus.value = trans('Unsaved changes')
  }
})

// Immediately update the available snippets
updateAvailableSnippets()

const offCallback = ipcRenderer.on('shortcut', (event, shortcut) => {
  if (shortcut === 'save-file') {
    saveSnippet()
  }
})

onUnmounted(() => { offCallback() })

function updateAvailableSnippets (selectAfterUpdate?: string): void {
  ipcRenderer.invoke('assets-provider', { command: 'list-snippets' })
    .then(data => {
      availableSnippets.value = data
      if (typeof selectAfterUpdate === 'string' && availableSnippets.value.includes(selectAfterUpdate)) {
        currentItem.value = availableSnippets.value.indexOf(selectAfterUpdate)
      }
      loadState()
    })
    .catch(err => console.error(err))
}

function loadState (): void {
  if (availableSnippets.value.length === 0) {
    editorContents.value = ''
    codeEditor.value?.markClean()
    savingStatus.value = ''
    currentSnippetText.value = ''
    currentItem.value = -1
    return // No state to load, only an error to avoid
  }

  if (currentItem.value >= availableSnippets.value.length) {
    currentItem.value = availableSnippets.value.length - 1
  } else if (currentItem.value < 0) {
    currentItem.value = 0
  }

  ipcRenderer.invoke('assets-provider', {
    command: 'get-snippet',
    payload: {
      name: availableSnippets.value[currentItem.value]
    }
  })
    .then(data => {
      editorContents.value = data
      codeEditor.value?.markClean()
      savingStatus.value = ''
      currentSnippetText.value = availableSnippets.value[currentItem.value]
    })
    .catch(err => console.error(err))
}

function saveSnippet (): void {
  savingStatus.value = trans('Saving …')

  ipcRenderer.invoke('assets-provider', {
    command: 'set-snippet',
    payload: {
      name: availableSnippets.value[currentItem.value],
      contents: editorContents.value
    }
  })
    .then(() => {
      savingStatus.value = trans('Saved!')
      setTimeout(() => { savingStatus.value = '' }, 1000)
    })
    .catch(err => {
      savingStatus.value = trans('Could not save changes')
      console.error(err)
    })
}

function addSnippet (newName?: string): void {
  // Adds a snippet with empty contents and a generic default name
  if (newName !== undefined) {
    newName = newName.trim()
  }
  if (newName === undefined || newName === '') {
    newName = ensureUniqueName('snippet')
  }

  ipcRenderer.invoke('assets-provider', {
    command: 'set-snippet',
    payload: {
      name: newName,
      contents: ''
    }
  })
    .then(() => { updateAvailableSnippets(newName) })
    .catch(err => console.error(err))
}

function removeSnippet (idx: number): void {
  if (idx > availableSnippets.value.length - 1 || idx < 0) {
    return
  }

  // Remove the current snippet.
  ipcRenderer.invoke('assets-provider', {
    command: 'remove-snippet',
    payload: { name: availableSnippets.value[idx] }
  })
    .then(() => { updateAvailableSnippets() })
    .catch(err => console.error(err))
}

function renameSnippet (): void {
  let newVal = currentSnippetText.value

  // Sanitise the name
  newVal = newVal.replace(/[^a-zA-Z0-9_-]/g, '-')

  newVal = ensureUniqueName(newVal)

  ipcRenderer.invoke('assets-provider', {
    command: 'rename-snippet',
    payload: {
      name: availableSnippets.value[currentItem.value],
      newName: newVal
    }
  })
    .then(() => { updateAvailableSnippets(newVal) })
    .catch(err => console.error(err))
}

/**
 * Ensures that the given name candidate describes a unique snippet filename
 *
 * @param   {string}  candidate  The candidate's name
 *
 * @return  {string}             The candidate's name, with a number suffix (-X) if necessary
 */
function ensureUniqueName (candidate: string): string {
  if (!availableSnippets.value.includes(candidate)) {
    return candidate // No duplicate detected
  }

  let count = 1
  const match = /-(\d+)$/.exec(candidate)

  if (match !== null) {
    // The candidate name already ends with a number-suffix --> extract it
    count = parseInt(match[1], 10)
    candidate = candidate.substring(0, candidate.length - match[1].length - 1)
  }

  while (availableSnippets.value.includes(candidate + '-' + String(count))) {
    count++
  }

  return candidate + '-' + count
}

function openSnippetsDirectory (): void {
  ipcRenderer.invoke('assets-provider', {
    command: 'open-snippets-directory'
  }).catch(err => console.error(err))
}
</script>

<style lang="css" scoped>
</style>
