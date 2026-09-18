<template>
  <div class="tikz-visual-preview">
    <div class="tikz-visual-toolbar">
      <div
        class="tikz-visual-tool-group"
        role="group"
        aria-label="Visual TikZ tools"
      >
        <button
          v-for="entry in toolButtons"
          :key="entry.id"
          type="button"
          :class="{ active: tool === entry.id }"
          :aria-pressed="tool === entry.id"
          :title="entry.title"
          @click="setTool(entry.id)"
        >
          {{ entry.label }}
        </button>
      </div>

      <template v-if="tool === 'rectangle' || tool === 'circle'">
        <label>
          <span>Name</span>
          <input
            v-model="creationName"
            class="tikz-visual-name-input"
            spellcheck="false"
            @keydown.stop
          >
        </label>
        <label class="tikz-visual-label-field">
          <span>Label</span>
          <input
            v-model="creationLabel"
            spellcheck="false"
            @keydown.stop
          >
        </label>
      </template>

      <span
        v-if="tool === 'arrow' && arrowStartNodeId !== null"
        class="tikz-visual-tool-hint"
      >
        Choose target node
      </span>
      <span
        v-else-if="tool === 'arrow'"
        class="tikz-visual-tool-hint"
      >
        Choose source node
      </span>

      <button
        type="button"
        class="tikz-visual-fit"
        title="Fit diagram to canvas"
        @click="fitScene"
      >
        Fit
      </button>
    </div>

    <div
      v-if="errorMessage !== ''"
      class="tikz-visual-error"
      role="status"
    >
      {{ errorMessage }}
    </div>
    <div
      v-else-if="scene.warnings.length > 0"
      class="tikz-visual-warning"
      role="status"
    >
      {{ scene.warnings.length }} TikZ statement{{ scene.warnings.length === 1 ? '' : 's' }}
      remain source-only and are preserved unchanged.
    </div>

    <div
      ref="viewport"
      class="tikz-visual-viewport"
      :class="`tool-${tool}`"
      :style="gridStyle"
      tabindex="0"
      @pointerdown="onViewportPointerDown"
      @wheel.prevent="onWheel"
    >
      <div
        class="tikz-visual-world"
        :style="worldStyle"
      >
        <svg
          class="tikz-visual-arrows"
          width="1"
          height="1"
          aria-hidden="true"
        >
          <defs>
            <marker
              :id="forwardMarkerId"
              markerWidth="7"
              markerHeight="7"
              refX="6"
              refY="3.5"
              orient="auto"
              markerUnits="strokeWidth"
            >
              <path
                d="M 0 0 L 7 3.5 L 0 7 z"
                fill="currentColor"
              />
            </marker>
            <marker
              :id="backwardMarkerId"
              markerWidth="7"
              markerHeight="7"
              refX="1"
              refY="3.5"
              orient="auto-start-reverse"
              markerUnits="strokeWidth"
            >
              <path
                d="M 7 0 L 0 3.5 L 7 7 z"
                fill="currentColor"
              />
            </marker>
          </defs>
          <g
            v-for="arrow in renderedArrows"
            :key="arrow.id"
            class="tikz-visual-arrow"
            :class="{ selected: selectedArrowId === arrow.id }"
          >
            <line
              class="tikz-visual-arrow-line"
              :x1="arrow.x1"
              :y1="arrow.y1"
              :x2="arrow.x2"
              :y2="arrow.y2"
              :marker-start="arrow.backwardArrow ? `url(#${backwardMarkerId})` : undefined"
              :marker-end="arrow.forwardArrow ? `url(#${forwardMarkerId})` : undefined"
            />
            <line
              class="tikz-visual-arrow-hit"
              :x1="arrow.x1"
              :y1="arrow.y1"
              :x2="arrow.x2"
              :y2="arrow.y2"
              @pointerdown.stop="selectArrow(arrow.id)"
            />
          </g>
        </svg>

        <button
          v-for="node in renderedNodes"
          :key="node.id"
          type="button"
          class="tikz-visual-node"
          :class="[
            `shape-${node.shape}`,
            {
              selected: selectedNodeId === node.id,
              'arrow-source': arrowStartNodeId === node.id,
              drawn: node.draw
            }
          ]"
          :style="node.style"
          :title="`${node.name} · (${node.x}, ${node.y})`"
          @pointerdown.stop="onNodePointerDown($event, node.id)"
          @dblclick.stop="focusLabelEditor(node.id)"
        >
          <TikzVisualLabel :label="node.label" />
          <span class="tikz-visual-node-name">{{ node.name }}</span>
        </button>
      </div>

      <div
        v-if="selectedNode !== null && tool === 'select'"
        class="tikz-visual-inspector"
        @pointerdown.stop
      >
        <div class="tikz-visual-inspector-heading">
          {{ selectedNode.name }}
          <span>{{ selectedNode.x }}, {{ selectedNode.y }}</span>
        </div>
        <label>
          <span>Label</span>
          <input
            ref="labelEditor"
            v-model="labelDraft"
            spellcheck="false"
            @keydown.enter.prevent="commitLabel"
            @keydown.esc.prevent="resetLabelDraft"
            @blur="commitLabel"
          >
        </label>
        <div class="tikz-visual-inspector-meta">
          {{ selectedNode.styleName ?? selectedNode.shape }}
        </div>
      </div>

      <div
        v-if="selectedArrow !== null && tool === 'select'"
        class="tikz-visual-inspector"
        @pointerdown.stop
      >
        <div class="tikz-visual-inspector-heading">
          {{ selectedArrow.from.node }} → {{ selectedArrow.to.node }}
        </div>
        <button
          type="button"
          class="tikz-visual-delete"
          @click="deleteSelectedArrow"
        >
          Delete arrow
        </button>
      </div>

      <div class="tikz-visual-zoom">
        {{ Math.round(zoom * 100) }}%
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Ipe-like visual tikzpicture preview provider
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Infinite-grid direct-manipulation editor for ordinary
 *                  tikzpicture source. It uses the parser-owned visual model
 *                  rather than rebuilding TikZ from canvas state. Dragging a
 *                  node replaces only its literal coordinate, label edits
 *                  replace only the node text payload, and new nodes/arrows
 *                  append individual TikZ statements. Unsupported TikZ stays
 *                  in source and is surfaced as source-only.
 *
 * END HEADER
 */

import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  shallowRef,
  watch
} from 'vue'
import type { EditorView } from '@codemirror/view'
import type { TikzLivePreviewTarget } from '@common/modules/markdown-editor/tikz-live-preview'
import {
  addTikzVisualArrow,
  addTikzVisualNode,
  deleteTikzVisualArrow,
  editTikzVisualNodeLabel,
  isValidTikzVisualNodeName,
  moveTikzVisualNode,
  nextTikzVisualNodeName,
  parseTikzVisualScene,
  replaceVisualSessionSource,
  visualSessionForBlock,
  type TikzNodeAnchor,
  type TikzVisualArrow,
  type TikzVisualNode,
  type TikzVisualScene,
  type TikzVisualSourceSession
} from '@common/modules/markdown-editor/tikz-visual'
import { reportError } from '@common/util/error-reporting'
import TikzVisualLabel from './TikzVisualLabel.vue'

const props = defineProps<{
  target: TikzLivePreviewTarget
  editorView: EditorView
  fullscreen: boolean
}>()

const emit = defineEmits<{
  (e: 'status', text: string): void
  (e: 'busy', busy: boolean): void
  (e: 'exitFullscreen'): void
}>()

type Tool = 'select'|'pan'|'rectangle'|'circle'|'arrow'

interface PreviewSession {
  source: TikzVisualSourceSession
  scene: TikzVisualScene
}

interface NodeDrag {
  kind: 'node'
  pointerId: number
  nodeId: string
  startWorldX: number
  startWorldY: number
  nodeStartX: number
  nodeStartY: number
}

interface PanDrag {
  kind: 'pan'
  pointerId: number
  startClientX: number
  startClientY: number
  panStartX: number
  panStartY: number
}

type DragState = NodeDrag|PanDrag

const UNIT_PX = 72
const MIN_ZOOM = 0.12
const MAX_ZOOM = 5
const SNAP_CM = 0.25

const toolButtons: readonly { id: Tool, label: string, title: string }[] = [
  { id: 'select', label: 'Select', title: 'Select and move nodes' },
  { id: 'pan', label: 'Hand', title: 'Pan the infinite canvas' },
  { id: 'rectangle', label: '□', title: 'Add rectangle node' },
  { id: 'circle', label: '○', title: 'Add circle node' },
  { id: 'arrow', label: '→', title: 'Connect two nodes with a directed arrow' }
]

function makeSession (target: TikzLivePreviewTarget): PreviewSession {
  const source = visualSessionForBlock(target)
  return { source, scene: parseTikzVisualScene(source.source) }
}

const session = shallowRef<PreviewSession>(makeSession(props.target))
const viewport = ref<HTMLDivElement|null>(null)
const labelEditor = ref<HTMLInputElement|null>(null)
const tool = ref<Tool>('select')
const zoom = ref(1)
const pan = reactive({ x: 0, y: 0 })
const drag = shallowRef<DragState|null>(null)
const dragPosition = shallowRef<{ nodeId: string, x: number, y: number }|null>(null)
const selectedNodeId = ref<string|null>(null)
const selectedArrowId = ref<string|null>(null)
const arrowStartNodeId = ref<string|null>(null)
const creationName = ref(nextTikzVisualNodeName(session.value.scene))
const creationLabel = ref('$A$')
const labelDraft = ref('')
const errorMessage = ref('')
const markerNamespace = crypto.randomUUID().replaceAll('-', '')
const forwardMarkerId = `tikz-visual-arrow-forward-${markerNamespace}`
const backwardMarkerId = `tikz-visual-arrow-backward-${markerNamespace}`
let didInitialFit = false

const scene = computed(() => session.value.scene)
const selectedNode = computed(() =>
  scene.value.nodes.find(node => node.id === selectedNodeId.value) ?? null
)
const selectedArrow = computed(() =>
  scene.value.arrows.find(arrow => arrow.id === selectedArrowId.value) ?? null
)

function sameBlockIdentity (a: TikzVisualSourceSession, b: TikzVisualSourceSession): boolean {
  return a.kind === b.kind && a.blockFrom === b.blockFrom
}

function preserveSelectionByName (nextScene: TikzVisualScene): void {
  const previous = selectedNode.value
  if (previous !== null) {
    selectedNodeId.value = nextScene.nodes.find(node => node.name === previous.name)?.id ?? null
  }
  if (selectedArrowId.value !== null && !nextScene.arrows.some(arrow => arrow.id === selectedArrowId.value)) {
    selectedArrowId.value = null
  }
}

watch(
  () => props.target,
  target => {
    try {
      const nextSource = visualSessionForBlock(target)
      const active = session.value
      if (!sameBlockIdentity(active.source, nextSource)) {
        const nextScene = parseTikzVisualScene(nextSource.source)
        session.value = { source: nextSource, scene: nextScene }
        selectedNodeId.value = null
        selectedArrowId.value = null
        arrowStartNodeId.value = null
        creationName.value = nextTikzVisualNodeName(nextScene)
        didInitialFit = false
        void nextTick(fitScene)
        return
      }

      if (active.source.source === nextSource.source) {
        session.value = { ...active, source: nextSource }
        return
      }

      const nextScene = parseTikzVisualScene(nextSource.source)
      preserveSelectionByName(nextScene)
      session.value = { source: nextSource, scene: nextScene }
      creationName.value = nextTikzVisualNodeName(nextScene)
      errorMessage.value = ''
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : String(error)
      reportError('Could not refresh visual TikZ scene', error)
    }
  }
)

watch(selectedNode, node => {
  labelDraft.value = node?.label ?? ''
})

const statusText = computed(() => {
  if (errorMessage.value !== '') return 'Visual source issue'
  if (scene.value.warnings.length > 0) {
    return `Synced · ${scene.value.warnings.length} source-only`
  }
  return 'Visual edits synced'
})

watch(statusText, text => { emit('status', text) }, { immediate: true })
emit('busy', false)

function applySource (nextSource: string): void {
  const active = session.value
  const current = props.editorView.state.sliceDoc(active.source.sourceFrom, active.source.sourceTo)
  if (current !== active.source.source) {
    errorMessage.value = 'Source changed before the visual edit could be applied. The canvas has reloaded from CodeMirror.'
    return
  }
  try {
    const replacement = replaceVisualSessionSource(active.source, nextSource)
    const nextScene = parseTikzVisualScene(nextSource)
    preserveSelectionByName(nextScene)
    props.editorView.dispatch({
      changes: {
        from: replacement.from,
        to: replacement.to,
        insert: replacement.insert
      }
    })
    session.value = { source: replacement.next, scene: nextScene }
    creationName.value = nextTikzVisualNodeName(nextScene)
    errorMessage.value = ''
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
    reportError('Could not apply visual TikZ edit', error)
  }
}

function setTool (next: Tool): void {
  tool.value = next
  arrowStartNodeId.value = null
  selectedArrowId.value = null
  if (next === 'rectangle' || next === 'circle') {
    creationName.value = nextTikzVisualNodeName(scene.value)
  }
}

function worldPointFromClient (clientX: number, clientY: number): { x: number, y: number } {
  const rect = viewport.value?.getBoundingClientRect()
  if (rect === undefined) return { x: 0, y: 0 }
  const screenX = clientX - rect.left - rect.width / 2 - pan.x
  const screenY = clientY - rect.top - rect.height / 2 - pan.y
  return {
    x: screenX / (UNIT_PX * zoom.value),
    y: -screenY / (UNIT_PX * zoom.value)
  }
}

function snap (value: number): number {
  return Math.round(value / SNAP_CM) * SNAP_CM
}

function nodePosition (node: TikzVisualNode): { x: number, y: number } {
  const draft = dragPosition.value
  return draft?.nodeId === node.id ? { x: draft.x, y: draft.y } : { x: node.x, y: node.y }
}

const renderedNodes = computed(() => scene.value.nodes.map(node => {
  const position = nodePosition(node)
  return {
    ...node,
    x: position.x,
    y: position.y,
    style: {
      left: `${position.x * UNIT_PX}px`,
      top: `${-position.y * UNIT_PX}px`,
      minWidth: `${node.widthCm * UNIT_PX}px`,
      minHeight: `${node.heightCm * UNIT_PX}px`
    }
  }
}))

function anchorPoint (node: TikzVisualNode, anchor: TikzNodeAnchor): { x: number, y: number } {
  const position = nodePosition(node)
  const x = position.x * UNIT_PX
  const y = -position.y * UNIT_PX
  const halfWidth = node.widthCm * UNIT_PX / 2
  const halfHeight = node.heightCm * UNIT_PX / 2
  switch (anchor) {
    case 'east': return { x: x + halfWidth, y }
    case 'west': return { x: x - halfWidth, y }
    case 'north': return { x, y: y - halfHeight }
    case 'south': return { x, y: y + halfHeight }
    case 'center': return { x, y }
  }
}

const renderedArrows = computed(() => {
  const nodes = new Map(scene.value.nodes.map(node => [ node.name, node ]))
  return scene.value.arrows.flatMap(arrow => {
    const fromNode = nodes.get(arrow.from.node)
    const toNode = nodes.get(arrow.to.node)
    if (fromNode === undefined || toNode === undefined) return []
    const from = anchorPoint(fromNode, arrow.from.anchor)
    const to = anchorPoint(toNode, arrow.to.anchor)
    return [{
      ...arrow,
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y
    }]
  })
})

const worldStyle = computed(() => ({
  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom.value})`
}))

const gridStyle = computed(() => ({
  '--tikz-grid-minor': `${UNIT_PX * zoom.value / 4}px`,
  '--tikz-grid-major': `${UNIT_PX * zoom.value}px`,
  '--tikz-grid-x': `calc(50% + ${pan.x}px)`,
  '--tikz-grid-y': `calc(50% + ${pan.y}px)`
}))

function onViewportPointerDown (event: PointerEvent): void {
  if (event.button === 1 || tool.value === 'pan' || tool.value === 'select') {
    if (event.button !== 0 && event.button !== 1) return
    if (tool.value === 'select' && event.button === 0) {
      selectedNodeId.value = null
      selectedArrowId.value = null
    }
    drag.value = {
      kind: 'pan',
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      panStartX: pan.x,
      panStartY: pan.y
    }
    viewport.value?.setPointerCapture(event.pointerId)
    return
  }

  if (tool.value === 'rectangle' || tool.value === 'circle') {
    const name = creationName.value.trim()
    if (!isValidTikzVisualNodeName(name)) {
      errorMessage.value = 'Enter a valid TikZ node name before placing the node.'
      return
    }
    const point = worldPointFromClient(event.clientX, event.clientY)
    const shape = tool.value
    applySource(addTikzVisualNode(scene.value, {
      shape,
      name,
      label: creationLabel.value,
      x: snap(point.x),
      y: snap(point.y)
    }))
  }
}

function onNodePointerDown (event: PointerEvent, nodeId: string): void {
  if (event.button !== 0) return
  if (tool.value === 'arrow') {
    if (arrowStartNodeId.value === null) {
      arrowStartNodeId.value = nodeId
      return
    }
    if (arrowStartNodeId.value === nodeId) {
      arrowStartNodeId.value = null
      return
    }
    applySource(addTikzVisualArrow(scene.value, arrowStartNodeId.value, nodeId))
    arrowStartNodeId.value = null
    return
  }
  if (tool.value !== 'select') return
  const node = scene.value.nodes.find(candidate => candidate.id === nodeId)
  if (node === undefined) return
  selectedNodeId.value = nodeId
  selectedArrowId.value = null
  const world = worldPointFromClient(event.clientX, event.clientY)
  drag.value = {
    kind: 'node',
    pointerId: event.pointerId,
    nodeId,
    startWorldX: world.x,
    startWorldY: world.y,
    nodeStartX: node.x,
    nodeStartY: node.y
  }
  viewport.value?.setPointerCapture(event.pointerId)
}

function onPointerMove (event: PointerEvent): void {
  const active = drag.value
  if (active === null || event.pointerId !== active.pointerId) return
  if (active.kind === 'pan') {
    pan.x = active.panStartX + event.clientX - active.startClientX
    pan.y = active.panStartY + event.clientY - active.startClientY
    return
  }
  const world = worldPointFromClient(event.clientX, event.clientY)
  dragPosition.value = {
    nodeId: active.nodeId,
    x: snap(active.nodeStartX + world.x - active.startWorldX),
    y: snap(active.nodeStartY + world.y - active.startWorldY)
  }
}

function onPointerUp (event: PointerEvent): void {
  const active = drag.value
  if (active === null || event.pointerId !== active.pointerId) return
  if (active.kind === 'node') {
    const final = dragPosition.value
    if (final?.nodeId === active.nodeId && (final.x !== active.nodeStartX || final.y !== active.nodeStartY)) {
      applySource(moveTikzVisualNode(scene.value, active.nodeId, final.x, final.y))
    }
  }
  drag.value = null
  dragPosition.value = null
  if (viewport.value?.hasPointerCapture(event.pointerId) === true) {
    viewport.value.releasePointerCapture(event.pointerId)
  }
}

function onWheel (event: WheelEvent): void {
  const host = viewport.value
  if (host === null) return
  const rect = host.getBoundingClientRect()
  const pointX = event.clientX - rect.left - rect.width / 2
  const pointY = event.clientY - rect.top - rect.height / 2
  const oldZoom = zoom.value
  const factor = Math.exp(-event.deltaY * 0.0015)
  const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, oldZoom * factor))
  const ratio = nextZoom / oldZoom
  pan.x = pointX - (pointX - pan.x) * ratio
  pan.y = pointY - (pointY - pan.y) * ratio
  zoom.value = nextZoom
}

function fitScene (): void {
  const host = viewport.value
  if (host === null || scene.value.nodes.length === 0) {
    pan.x = 0
    pan.y = 0
    zoom.value = 1
    return
  }
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const node of scene.value.nodes) {
    minX = Math.min(minX, node.x * UNIT_PX - node.widthCm * UNIT_PX / 2)
    maxX = Math.max(maxX, node.x * UNIT_PX + node.widthCm * UNIT_PX / 2)
    minY = Math.min(minY, -node.y * UNIT_PX - node.heightCm * UNIT_PX / 2)
    maxY = Math.max(maxY, -node.y * UNIT_PX + node.heightCm * UNIT_PX / 2)
  }
  const width = Math.max(UNIT_PX, maxX - minX)
  const height = Math.max(UNIT_PX, maxY - minY)
  const nextZoom = Math.min(
    2.5,
    Math.max(MIN_ZOOM, Math.min(host.clientWidth * 0.82 / width, host.clientHeight * 0.78 / height))
  )
  zoom.value = nextZoom
  pan.x = -((minX + maxX) / 2) * nextZoom
  pan.y = -((minY + maxY) / 2) * nextZoom
  didInitialFit = true
}

function selectArrow (arrowId: string): void {
  if (tool.value !== 'select') return
  selectedArrowId.value = arrowId
  selectedNodeId.value = null
}

function deleteSelectedArrow (): void {
  if (selectedArrowId.value === null) return
  applySource(deleteTikzVisualArrow(scene.value, selectedArrowId.value))
  selectedArrowId.value = null
}

function commitLabel (): void {
  const node = selectedNode.value
  if (node === null || labelDraft.value === node.label) return
  applySource(editTikzVisualNodeLabel(scene.value, node.id, labelDraft.value))
}

function resetLabelDraft (): void {
  labelDraft.value = selectedNode.value?.label ?? ''
  viewport.value?.focus()
}

async function focusLabelEditor (nodeId: string): Promise<void> {
  selectedNodeId.value = nodeId
  selectedArrowId.value = null
  tool.value = 'select'
  await nextTick()
  labelEditor.value?.focus()
  labelEditor.value?.select()
}

function onWindowKeydown (event: KeyboardEvent): void {
  const target = event.target
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
  if ((event.key === 'Delete' || event.key === 'Backspace') && selectedArrowId.value !== null) {
    event.preventDefault()
    deleteSelectedArrow()
  }
  if (event.key === 'Escape') {
    arrowStartNodeId.value = null
    drag.value = null
    dragPosition.value = null
  }
}

watch(
  () => props.fullscreen,
  async () => {
    await nextTick()
    if (!didInitialFit) fitScene()
  }
)

onMounted(() => {
  window.addEventListener('pointermove', onPointerMove, true)
  window.addEventListener('pointerup', onPointerUp, true)
  window.addEventListener('pointercancel', onPointerUp, true)
  window.addEventListener('keydown', onWindowKeydown)
  void nextTick(fitScene)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onPointerMove, true)
  window.removeEventListener('pointerup', onPointerUp, true)
  window.removeEventListener('pointercancel', onPointerUp, true)
  window.removeEventListener('keydown', onWindowKeydown)
})
</script>

<style scoped lang="less">
.tikz-visual-preview {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.tikz-visual-toolbar {
  flex: 0 0 auto;
  min-height: 36px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 8px;
  border-bottom: 1px solid color-mix(in srgb, currentColor 16%, transparent);
  background: color-mix(in srgb, currentColor 3%, transparent);
  font-size: 0.76rem;

  button,
  input {
    border: 1px solid color-mix(in srgb, currentColor 24%, transparent);
    border-radius: 4px;
    background: color-mix(in srgb, currentColor 4%, transparent);
    color: inherit;
    font: inherit;
  }

  button {
    padding: 4px 7px;
    cursor: pointer;
  }

  button.active {
    background: color-mix(in srgb, currentColor 15%, transparent);
    border-color: color-mix(in srgb, currentColor 42%, transparent);
  }

  label {
    display: inline-flex;
    align-items: center;
    gap: 4px;

    > span { opacity: 0.62; }
  }

  input {
    min-width: 0;
    padding: 3px 5px;
  }
}

.tikz-visual-tool-group {
  display: inline-flex;
  gap: 2px;
}

.tikz-visual-name-input { width: 7em; }
.tikz-visual-label-field { flex: 1 1 12em; }
.tikz-visual-label-field input { width: 100%; }
.tikz-visual-tool-hint { opacity: 0.62; font-style: italic; }
.tikz-visual-fit { margin-left: auto; }

.tikz-visual-error,
.tikz-visual-warning {
  flex: 0 0 auto;
  padding: 5px 10px;
  border-bottom: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  font-size: 0.76rem;
}

.tikz-visual-error {
  color: #a93226;
  background: rgba(192, 57, 43, 0.07);
}

.tikz-visual-warning {
  opacity: 0.7;
}

.tikz-visual-viewport {
  --tikz-grid-minor: 18px;
  --tikz-grid-major: 72px;
  --tikz-grid-x: 50%;
  --tikz-grid-y: 50%;
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  outline: none;
  touch-action: none;
  background-image:
    linear-gradient(to right, color-mix(in srgb, currentColor 6%, transparent) 1px, transparent 1px),
    linear-gradient(to bottom, color-mix(in srgb, currentColor 6%, transparent) 1px, transparent 1px),
    linear-gradient(to right, color-mix(in srgb, currentColor 13%, transparent) 1px, transparent 1px),
    linear-gradient(to bottom, color-mix(in srgb, currentColor 13%, transparent) 1px, transparent 1px);
  background-size:
    var(--tikz-grid-minor) var(--tikz-grid-minor),
    var(--tikz-grid-minor) var(--tikz-grid-minor),
    var(--tikz-grid-major) var(--tikz-grid-major),
    var(--tikz-grid-major) var(--tikz-grid-major);
  background-position:
    var(--tikz-grid-x) var(--tikz-grid-y),
    var(--tikz-grid-x) var(--tikz-grid-y),
    var(--tikz-grid-x) var(--tikz-grid-y),
    var(--tikz-grid-x) var(--tikz-grid-y);
}

.tikz-visual-viewport.tool-pan { cursor: grab; }
.tikz-visual-viewport.tool-pan:active { cursor: grabbing; }
.tikz-visual-viewport.tool-rectangle,
.tikz-visual-viewport.tool-circle { cursor: crosshair; }

.tikz-visual-world {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 0;
  height: 0;
  transform-origin: 0 0;
  will-change: transform;
}

.tikz-visual-arrows {
  position: absolute;
  left: 0;
  top: 0;
  overflow: visible;
  color: currentColor;
}

.tikz-visual-arrow-line {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.35;
}

.tikz-visual-arrow.selected .tikz-visual-arrow-line {
  stroke-width: 2.4;
}

.tikz-visual-arrow-hit {
  fill: none;
  stroke: transparent;
  stroke-width: 12;
  pointer-events: stroke;
  cursor: pointer;
}

.tikz-visual-node {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  transform: translate(-50%, -50%);
  box-sizing: border-box;
  padding: 0.08cm 0.15cm;
  border: 1.25px solid transparent;
  background: var(--system-accent-color, Canvas);
  background: color-mix(in srgb, Canvas 96%, transparent);
  color: inherit;
  font: inherit;
  cursor: move;
  user-select: none;
  touch-action: none;
}

.tikz-visual-node.drawn {
  border-color: currentColor;
}

.tikz-visual-node.shape-circle {
  border-radius: 50%;
  aspect-ratio: 1;
  padding: 0.08cm;
}

.tikz-visual-node.selected {
  outline: 2px solid Highlight;
  outline-offset: 3px;
}

.tikz-visual-node.arrow-source {
  outline: 2px dashed Highlight;
  outline-offset: 4px;
}

.tikz-visual-node-name {
  position: absolute;
  left: 50%;
  top: 100%;
  transform: translate(-50%, 4px);
  padding: 1px 3px;
  border-radius: 3px;
  background: color-mix(in srgb, Canvas 88%, transparent);
  font-size: 9px;
  opacity: 0;
  pointer-events: none;
  white-space: nowrap;
}

.tikz-visual-node.selected .tikz-visual-node-name,
.tikz-visual-node:hover .tikz-visual-node-name {
  opacity: 0.68;
}

.tikz-visual-inspector {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 4;
  width: min(280px, calc(100% - 20px));
  padding: 8px;
  border: 1px solid color-mix(in srgb, currentColor 24%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, Canvas 96%, transparent);
  box-shadow: 0 3px 12px color-mix(in srgb, currentColor 12%, transparent);
  font-size: 0.78rem;

  label {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 6px;
    align-items: center;
    margin-top: 7px;
  }

  input,
  button {
    min-width: 0;
    border: 1px solid color-mix(in srgb, currentColor 24%, transparent);
    border-radius: 4px;
    background: transparent;
    color: inherit;
    font: inherit;
    padding: 4px 6px;
  }
}

.tikz-visual-inspector-heading {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-weight: 600;
}

.tikz-visual-inspector-heading span,
.tikz-visual-inspector-meta {
  opacity: 0.55;
  font-weight: 400;
}

.tikz-visual-inspector-meta { margin-top: 5px; }
.tikz-visual-delete { margin-top: 7px; cursor: pointer; }

.tikz-visual-zoom {
  position: absolute;
  right: 8px;
  bottom: 7px;
  padding: 2px 5px;
  border-radius: 4px;
  background: color-mix(in srgb, Canvas 82%, transparent);
  font-size: 0.7rem;
  opacity: 0.65;
  user-select: none;
  pointer-events: none;
}

:global(body.dark .tikz-visual-error) {
  color: #e67e73;
  background: rgba(192, 57, 43, 0.09);
}
</style>
