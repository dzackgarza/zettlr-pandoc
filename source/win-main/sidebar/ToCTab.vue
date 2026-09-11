<template>
  <div class="outline-entries">
    <div
      v-for="(entry, idx) of tableOfContents"
      v-bind:key="idx"
      v-bind:data-line="entry.line"
      v-bind:class="{
        'chrome-row': true,
        'toc-entry-container': true,
        ['toc-heading-' + entry.level]: true,
        'chrome-row-active': tocEntryIsActive(entry.line, idx)
      }"
      v-bind:style="{ 'padding-left': `calc(${entry.level - 1} * var(--chrome-indent) + var(--chrome-inset))` }"
      draggable="true"
      v-on:click="emit('jump-to-line', entry.line)"
      v-on:dragstart="startDragging"
      v-on:dragover="dragOver"
      v-on:drop="drop"
    >
      <span class="chrome-row-detail toc-level">
        {{ entry.renderedLevel }}
      </span>
      <span
        v-bind:class="{ 'chrome-row-label': true, 'toc-entry': true, 'toc-entry-active': tocEntryIsActive(entry.line, idx) }"
        v-bind:data-line="entry.line"
      >
        <!-- eslint-disable-next-line vue/no-v-html NOTE we can only disable this error here since the entries are run through DOMPurify. -->
        <span v-html="tocEntryHTML[idx]"></span>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ToCTab
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     The Outline module's body: the active document's headings
 *                  as numbered rows, one indent per heading level, with
 *                  click-to-jump and drag-to-move-section. The module header
 *                  carries the label; this body renders entries only.
 *
 * END HEADER
 */

import { ref, computed, watch, toRef, onMounted } from 'vue'
import { CITEPROC_MAIN_DB } from '@dts/common/citeproc'
import { type AnyDescriptor } from '@dts/common/fsal'
import { md2html } from '@common/modules/markdown-utils'
import { useConfigStore, useDocumentTreeStore, useWindowStateStore } from 'source/pinia'

const ipcRenderer = window.ipc
const windowStateStore = useWindowStateStore()
const documentTreeStore = useDocumentTreeStore()
const configStore = useConfigStore()

const emit = defineEmits<{
  (e: 'move-section', data: { from: number, to: number }): void
  (e: 'jump-to-line', line: number): void
}>()

// The active document's descriptor feeds the citation library the heading
// text is rendered with; nothing else of it is shown here.
const activeFileDescriptor = ref<AnyDescriptor|null>(null)
const library = ref<string>(CITEPROC_MAIN_DB)

const tableOfContents = computed(() => windowStateStore.tableOfContents)
const tocEntryHTML = ref<string[]>([])

watch(toRef(tableOfContents), updateToCHTML)
onMounted(updateToCHTML)

const activeFile = computed(() => documentTreeStore.lastLeafActiveFile)

watch(activeFile, async (newValue) => {
  if (newValue === undefined) {
    activeFileDescriptor.value = null
  } else {
    const descriptor: AnyDescriptor|undefined = await ipcRenderer.invoke('fsal', {
      command: 'get-descriptor',
      payload: newValue.path
    })

    activeFileDescriptor.value = descriptor ?? null
  }
})

watch(activeFileDescriptor, (newValue) => {
  if (newValue === null || newValue.type !== 'file') {
    library.value = CITEPROC_MAIN_DB
  } else {
    const fm = newValue.frontmatter
    if (fm != null && 'bibliography' in fm && typeof fm.bibliography === 'string' && fm.bibliography.length > 0) {
      library.value = fm.bibliography
    }
  }
})

/**
 * Whether the cursor is within the corresponding document section
 *
 * @param   {number}  tocEntryLine          Line number of section heading
 * @param   {number}  tocEntryIdx           Index of heading in ToC
 */
function tocEntryIsActive (tocEntryLine: number, tocEntryIdx: number): boolean {
  if (tableOfContents.value === undefined || windowStateStore.activeDocumentInfo === undefined) {
    return false
  }

  const cursorLine = windowStateStore.activeDocumentInfo.cursor.line

  // Determine index of next heading in ToC list
  const nextTocEntryIdx = Math.min(tocEntryIdx + 1, tableOfContents.value.length - 1)

  // Now, determine the next heading's line number
  let nextTocEntryLine = Infinity
  if (tocEntryIdx !== nextTocEntryIdx) {
    nextTocEntryLine = tableOfContents.value[nextTocEntryIdx].line
  }

  // True, when cursor lies between current and next heading
  return (cursorLine >= tocEntryLine && cursorLine < nextTocEntryLine)
}

/**
 * Converts the ToC entries's texts to (safe) HTML.
 */
function updateToCHTML () {
  if (tableOfContents.value === undefined) {
    return
  }

  const promises: Promise<string>[] = []

  for (const entry of tableOfContents.value) {
    promises.push(
      md2html(entry.text, {
        onCitation: window.getCitationCallback(library.value),
        zknLinkFormat: configStore.config.zkn.linkFormat
      })
    )
  }

  Promise.all(promises)
    .then(values => {
      tocEntryHTML.value = values
    })
    .catch(err => console.error(err))
}

function startDragging (event: DragEvent): void {
  if (event.currentTarget === null) {
    return
  }
  const fromLine = (event.currentTarget as HTMLElement).dataset.line
  if (fromLine !== undefined) {
    event.dataTransfer?.setData('x-zettlr/toc-drag', fromLine)
  }
}

function dragOver (event: DragEvent): void {
  const elem = document.querySelectorAll('.toc-entry-container')
  elem.forEach(e => e.classList.remove('toc-drop-effect'))
  const container = event.currentTarget as HTMLElement
  container.classList.add('toc-drop-effect')
}

function drop (event: DragEvent): void {
  if (event.currentTarget === null || event.dataTransfer === null) {
    return
  }

  const container = event.currentTarget as HTMLElement
  container.classList.remove('toc-drop-effect')

  if (container.dataset.line === undefined) {
    return
  }

  const fromLine = parseInt(event.dataTransfer.getData('x-zettlr/toc-drag'), 10)
  const toLine = parseInt(container.dataset.line, 10)
  if (fromLine === toLine) {
    return
  }

  const actualToLine = findEndOfEntry(toLine)
  if (actualToLine === undefined) {
    console.warn('Could not move section: Could not find correct target line')
    return
  }

  emit('move-section', { from: fromLine, to: actualToLine })
}

function findEndOfEntry (originalToLine: number): number|undefined {
  if (tableOfContents.value == null) {
    return
  }

  const idx = tableOfContents.value.findIndex(elem => elem.line === originalToLine)

  if (idx < 0) {
    return
  }

  if (idx === tableOfContents.value.length - 1) {
    return -1
  } else {
    return tableOfContents.value[idx + 1].line
  }
}
</script>

<style lang="less">
.outline-entries {
  height: 100%;
  overflow-y: auto;
  padding: 4px 0;
}

// The numbered heading rows; a dragged entry marks its drop target below it.
.toc-entry-container {
  border-bottom: 2px solid transparent;

  .toc-level {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
  }

  &.toc-drop-effect {
    border-bottom-color: var(--chrome-row-accent);
  }
}
</style>
