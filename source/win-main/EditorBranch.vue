<template>
  <div
    ref="rootElement"
    :class="{
      'split-pane-container': true,
      'border-right': !props.isLast && props.node.direction === 'vertical',
      'border-bottom': !props.isLast && props.node.direction === 'horizontal'
    }"
    :style="elementStyles"
  >
    <template
      v-for="(subNode, index) in node.nodes"
      :key="JSON.stringify(subNode)"
    >
      <EditorBranch
        v-if="subNode.type === 'branch'"
        :key="`branch-${index}`"
        :node="subNode"
        :window-id="windowId"
        :editor-commands="editorCommands"
        :available-width="(node.direction === 'horizontal') ? sizes[index] : 100"
        :available-height="(node.direction === 'vertical') ? sizes[index] : 100"
        :is-last="index === node.nodes.length - 1 || node.nodes.length === 1"
        @global-search="emit('globalSearch', $event)"
        @reference-search="emit('referenceSearch', $event)"
        @create-reference-label="emit('createReferenceLabel', $event)"
        @open-pandoc-quick-help="emit('openPandocQuickHelp')"
      />
      <EditorPane
        v-else
        :key="subNode.id"
        :leaf-id="subNode.id"
        :window-id="windowId"
        :editor-commands="editorCommands"
        :class="{
          'border-right': paneShouldHaveBorderRight(index),
          'border-bottom': paneShouldHaveBorderBottom(index)
        }"
        :available-width="(node.direction === 'horizontal') ? sizes[index] : 100"
        :available-height="(node.direction === 'vertical') ? sizes[index] : 100"
        @global-search="emit('globalSearch', $event)"
        @reference-search="emit('referenceSearch', $event)"
        @create-reference-label="emit('createReferenceLabel', $event)"
        @open-pandoc-quick-help="emit('openPandocQuickHelp')"
      />
      <!-- Here comes the resizing (for every but the last child) -->
      <div
        v-if="index < node.nodes.length - 1"
        :class="`resizer ${node.direction}`"
        @mousedown="beginResizing($event, index)"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import EditorPane from './EditorPane.vue'
import { type BranchNodeJSON } from '@dts/common/documents'
import { ref, computed, watch, toRef } from 'vue'
import type { CreateReferenceLabelDialogPrompt, EditorCommands } from './component-contracts'
import type { ReferenceSearchRequest } from '@common/modules/markdown-editor/plugins/reference-search-effect'
import type { DocumentManagerIPCAPI } from 'source/app/service-providers/documents'

const ipcRenderer = window.ipc

const props = defineProps<{
  node: BranchNodeJSON
  windowId: string
  availableWidth?: number
  availableHeight?: number
  isLast?: boolean
  editorCommands: EditorCommands
}>()

const emit = defineEmits<{
  (e: 'globalSearch', query: string): void
  (e: 'referenceSearch', request: ReferenceSearchRequest): void
  (e: 'createReferenceLabel', prompt: CreateReferenceLabelDialogPrompt): void
  (e: 'openPandocQuickHelp'): void
}>()

const sizes = ref<number[]>(props.node.sizes.map(s => s))
const currentResizerIndex = ref<number>(-1)
const lastOffset = ref<number>(0)

const elementStyles = computed<string>(() => {
  const rules = [
    `width: ${props.availableWidth ?? 100}%; height: ${props.availableHeight ?? 100}%`
  ]
  if (props.node.type === 'branch') {
    if (props.node.direction === 'horizontal') {
      rules.push('flex-direction: row')
    } else {
      rules.push('flex-direction: column')
    }
  }
  return rules.join('; ')
})

const rootElement = ref<HTMLDivElement|null>(null)

const isHorizontalBranch = computed<boolean>(() => props.node.direction === 'horizontal')

watch(toRef(props, 'node'), () => {
  sizes.value = props.node.sizes.map(s => s)
})

/**
 * Should the pane with the provided index have a right border?
 *
 * @param   {number}   index  The index to check
 *
 * @return  {boolean}         True if it should have a border
 */
function paneShouldHaveBorderRight (index: number): boolean {
  if (props.node.direction === 'horizontal') {
    // In horizontal mode, all panes except the last one get a border right
    return index < props.node.nodes.length - 1
  } else {
    return false // The branch itself will have the border
  }
}

/**
 * Should the pane with the provided index have a bottom border?
 *
 * @param   {number}   index  The index to check
 *
 * @return  {boolean}         True if it should have a border
 */
function paneShouldHaveBorderBottom (index: number): boolean {
  if (props.node.direction === 'vertical') {
    // Reversed: Bottom border applies to all but the last element in vertical mode
    return index < props.node.nodes.length - 1
  } else {
    return false // The branch itself will have the border
  }
}

function beginResizing (event: MouseEvent, index: number): void {
  currentResizerIndex.value = index
  lastOffset.value = isHorizontalBranch.value ? event.clientX : event.clientY
  rootElement.value?.addEventListener('mousemove', onResizing)
  rootElement.value?.addEventListener('mouseup', onEndResizing)
}

function onResizing (event: MouseEvent): void {
  if (currentResizerIndex.value < 0 || rootElement.value === null) {
    return
  }

  const node1 = currentResizerIndex.value
  const node2 = node1 + 1
  const offset = isHorizontalBranch.value ? event.clientX : event.clientY

  // Convert from pixels to percent
  const offsetPixels = Math.abs(lastOffset.value - offset)
  const rect = rootElement.value.getBoundingClientRect()
  const totalPixels = isHorizontalBranch.value ? rect.width : rect.height
  const offsetPercent = offsetPixels / totalPixels * 100

  if (offset > lastOffset.value) {
    // Direction --> or v
    sizes.value[node1] += offsetPercent
    sizes.value[node2] -= offsetPercent
  } else if (offset < lastOffset.value) {
    // Direction <-- or ^
    sizes.value[node1] -= offsetPercent
    sizes.value[node2] += offsetPercent
  }

  lastOffset.value = offset
}

function onEndResizing (_event: MouseEvent): void {
  currentResizerIndex.value = -1
  lastOffset.value = 0
  rootElement.value?.removeEventListener('mousemove', onResizing)
  rootElement.value?.removeEventListener('mouseup', onEndResizing)
  // Inform main about the new sizes
  ipcRenderer.invoke('documents-provider', {
    command: 'set-branch-sizes',
    payload: {
      windowId: props.windowId,
      branchId: props.node.id,
      sizes: sizes.value.map(s => s) // Again, deproxy
    }
  } as DocumentManagerIPCAPI)
    .catch(err => console.error(err))
}
</script>

<style lang="less">
body .split-pane-container {
  display: flex;
  width: 100%;
  height: 100%;

  .resizer {
    z-index: 1;
    transition: background-color 0.5s ease;

    &:hover { background-color: rgba(128, 128, 128, .5); }
  }

  .resizer.horizontal {
    width: 5px;
    margin: 0 -2.5px;
    height: 100%;
    cursor: ew-resize;
  }

  .resizer.vertical {
    width: 100%;
    margin: -2.5px 0;
    height: 5px;
    cursor: ns-resize;
  }

  .editor-pane, & {
    &.border-right { border-right: 1px solid #d5d5d5; }
    &.border-bottom { border-bottom: 1px solid #d5d5d5; }
  }
}

body.dark .split-pane-container {
  .editor-pane, & {
    &.border-right { border-color: #505050; }
    &.border-bottom { border-color: #505050; }
  }
}
</style>
