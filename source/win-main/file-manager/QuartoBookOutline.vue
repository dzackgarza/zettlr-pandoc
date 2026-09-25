<template>
  <section class="quarto-book-outline" aria-label="Book navigation">
    <div class="book-controls">
      <button type="button" v-bind:disabled="previousPath === undefined" v-on:click.stop="openPath(previousPath)">
        <cds-icon shape="angle" direction="left"></cds-icon>
        {{ previousLabel }}
      </button>
      <span class="book-position">{{ currentPosition }}</span>
      <button type="button" v-bind:disabled="nextPath === undefined" v-on:click.stop="openPath(nextPath)">
        {{ nextLabel }}
        <cds-icon shape="angle" direction="right"></cds-icon>
      </button>
      <button
        type="button"
        class="manage-book"
        v-bind:aria-pressed="showAuthoringControls"
        v-on:click.stop="showAuthoringControls = !showAuthoringControls"
      >
        {{ manageLabel }}
      </button>
    </div>
    <div v-if="showAuthoringControls" class="book-authoring">
      <div class="authoring-row">
        <select v-model="omittedChapter" data-book-control="omitted-chapter" v-bind:disabled="omittedCandidates.length === 0">
          <option value="">{{ omittedCandidates.length === 0 ? noOmittedLabel : chooseChapterLabel }}</option>
          <option
            v-for="candidate in omittedCandidates"
            v-bind:key="candidate.path"
            v-bind:value="candidate.relativePath"
          >
            {{ candidate.label }} — {{ candidate.relativePath }}
          </option>
        </select>
        <button type="button" data-book-action="add-chapter" v-bind:disabled="omittedChapter === ''" v-on:click="addSelectedChapter">
          {{ addChapterLabel }}
        </button>
      </div>
      <div class="authoring-row">
        <input
          v-model="newChapterName"
          data-book-control="new-chapter-name"
          type="text"
          v-bind:placeholder="newChapterPlaceholder"
          v-on:keyup.enter="createChapter"
        >
        <select v-model="newChapterPlacement" data-book-control="new-chapter-placement">
          <option value="after-active" v-bind:disabled="activeRelativePath === undefined || !project?.files.includes(activeRelativePath)">
            {{ afterCurrentLabel }}
          </option>
          <option value="part-end" v-bind:disabled="currentPartIndex < 0">
            {{ endCurrentPartLabel }}
          </option>
          <option value="book-end">{{ endBookLabel }}</option>
        </select>
        <button type="button" data-book-action="new-chapter" v-bind:disabled="newChapterName.trim() === ''" v-on:click="createChapter">
          {{ newChapterLabel }}
        </button>
      </div>
      <div class="authoring-row">
        <input
          v-model="newPartTitle"
          data-book-control="new-part-title"
          type="text"
          v-bind:placeholder="partTitlePlaceholder"
        >
        <select v-model="partChapter" data-book-control="part-chapter" v-bind:disabled="allMarkdownCandidates.length === 0">
          <option value="">{{ chooseChapterLabel }}</option>
          <option
            v-for="candidate in allMarkdownCandidates"
            v-bind:key="candidate.path"
            v-bind:value="candidate.relativePath"
          >
            {{ candidate.label }} — {{ candidate.relativePath }}
          </option>
        </select>
        <button
          type="button"
          data-book-action="add-part"
          v-bind:disabled="newPartTitle.trim() === '' || partChapter === ''"
          v-on:click="addPart"
        >
          {{ addPartLabel }}
        </button>
      </div>
      <p class="authoring-hint">{{ dragHint }}</p>
    </div>
    <nav>
      <template v-for="(item, itemIndex) in outline.items" v-bind:key="item.kind === 'chapter' ? item.path : item.title">
        <button
          v-if="item.kind === 'chapter'"
          type="button"
          v-bind:class="{ 'chrome-row': true, chapter: true, active: item.path === activeItem, 'chrome-row-active': item.path === activeItem }"
          draggable="true"
          v-on:click.stop="openPath(item.path, 1)"
          v-on:dragstart="beginChapterDrag(item.path, $event)"
          v-on:dragend="endChapterDrag"
          v-on:dragover.prevent
          v-on:drop.prevent="dropBefore(item.path)"
        >
          <span class="chrome-row-detail chapter-number">{{ item.position }}</span>
          <span class="chrome-row-label">{{ item.title }}</span>
        </button>
        <section v-else-if="item.kind === 'part'" class="book-part">
          <h4
            class="chrome-group-label part-drop-target"
            v-on:dragover.prevent
            v-on:drop.prevent="dropIntoPart(itemIndex)"
          >
            {{ item.title }}
          </h4>
          <button
            v-for="chapter in item.chapters"
            v-bind:key="chapter.path"
            type="button"
            v-bind:class="{ 'chrome-row': true, chapter: true, active: chapter.path === activeItem, 'chrome-row-active': chapter.path === activeItem }"
            draggable="true"
            v-on:click.stop="openPath(chapter.path, 1)"
            v-on:dragstart="beginChapterDrag(chapter.path, $event)"
            v-on:dragend="endChapterDrag"
            v-on:dragover.prevent
            v-on:drop.prevent="dropBefore(chapter.path)"
          >
            <span class="chrome-row-detail chapter-number">{{ chapter.position }}</span>
            <span class="chrome-row-label">{{ chapter.title }}</span>
          </button>
        </section>
      </template>
      <div
        v-if="draggedChapter !== undefined"
        class="book-end-drop"
        v-on:dragover.prevent
        v-on:drop.prevent="dropAtBookEnd"
      >
        {{ moveToBookEndLabel }}
      </div>
    </nav>
  </section>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        QuartoBookOutline
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The Book module's body: a Quarto book's parts and
 *                  chapters in manifest order, with previous and next. The
 *                  active document's headings are the Outline module's; no
 *                  heading row appears here.
 *
 * END HEADER
 */

import { computed, ref, watch } from 'vue'
import { trans } from '@common/i18n-renderer'
import { isInsideRoot, pathBasename, pathDirname } from '@common/util/renderer-path-polyfill'
import type { MDFileDescriptor, ProjectNavigationItem } from '@dts/common/fsal'
import { useWorkspaceStore } from 'source/pinia'
import { buildQuartoBookOutline } from './quarto-book-outline'
import { projectRelativePath } from '@common/util/explorer-ordering'
import type { QuartoBookEdit, QuartoChapterPlacement } from 'source/app/util/quarto-book-editor'
import { reportError } from '@common/util/error-reporting'
import showToast from '@common/util/show-toast'

const workspaceStore = useWorkspaceStore()
const props = defineProps<{
  rootPath: string
  navigation: ProjectNavigationItem[]
  activeItem?: string
}>()
const emit = defineEmits<(event: 'jump', target: { filePath: string, line: number }) => void>()

const previousLabel = trans('Previous')
const nextLabel = trans('Next')
const manageLabel = trans('Manage')
const addChapterLabel = trans('Add to book')
const newChapterLabel = trans('New chapter')
const addPartLabel = trans('Add part')
const chooseChapterLabel = trans('Choose a chapter…')
const noOmittedLabel = trans('No omitted documents')
const newChapterPlaceholder = trans('New chapter filename')
const afterCurrentLabel = trans('After current')
const endCurrentPartLabel = trans('End of current part')
const endBookLabel = trans('End of book')
const partTitlePlaceholder = trans('Part title')
const dragHint = trans('Drag chapters to reorder them. Drop a chapter on a part heading to move it into that part, or on the end target to move it to top level.')
const moveToBookEndLabel = trans('Move to end of book')
const showAuthoringControls = ref(false)
const omittedChapter = ref('')
const newChapterName = ref('')
const newChapterPlacement = ref<'after-active'|'part-end'|'book-end'>('after-active')
const newPartTitle = ref('')
const partChapter = ref('')
const draggedChapter = ref<string>()

const outline = computed(() => buildQuartoBookOutline(props.rootPath, props.navigation, filePath => {
  const descriptor = workspaceStore.descriptorMap.get(filePath)
  if (descriptor?.type === 'file') {
    return descriptor.yamlTitle ?? descriptor.firstHeading ?? descriptor.name
  }
  return pathBasename(filePath)
}))

const activeIndex = computed(() => props.activeItem === undefined
  ? -1
  : outline.value.orderedPaths.indexOf(props.activeItem))
const previousPath = computed(() => activeIndex.value > 0
  ? outline.value.orderedPaths[activeIndex.value - 1]
  : undefined)
const nextPath = computed(() => activeIndex.value >= 0 && activeIndex.value < outline.value.orderedPaths.length - 1
  ? outline.value.orderedPaths[activeIndex.value + 1]
  : undefined)
const currentPosition = computed(() => activeIndex.value < 0
  ? ''
  : `${activeIndex.value + 1} / ${outline.value.orderedPaths.length}`)

const projectRoot = computed(() => {
  const descriptor = workspaceStore.descriptorMap.get(props.rootPath)
  return descriptor?.type === 'directory' ? descriptor : undefined
})

const project = computed(() => {
  const settings = projectRoot.value?.settings.project
  return settings?.manifest.kind === 'quarto' ? settings : undefined
})

interface ChapterCandidate {
  path: string
  relativePath: string
  label: string
}

const allMarkdownCandidates = computed<ChapterCandidate[]>(() => {
  return [...workspaceStore.descriptorMap.values()]
    .filter((descriptor): descriptor is MDFileDescriptor => {
      return descriptor.type === 'file' && isInsideRoot(descriptor.path, props.rootPath)
    })
    .map(descriptor => ({
      path: descriptor.path,
      relativePath: projectRelativePath(descriptor.path, props.rootPath),
      label: descriptor.yamlTitle ?? descriptor.firstHeading ?? descriptor.name
    }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true }))
})

const omittedCandidates = computed(() => {
  const included = new Set(project.value?.files ?? [])
  return allMarkdownCandidates.value.filter(candidate => !included.has(candidate.relativePath))
})

const activeRelativePath = computed(() => {
  const active = props.activeItem
  return active !== undefined && isInsideRoot(active, props.rootPath)
    ? projectRelativePath(active, props.rootPath)
    : undefined
})

const currentPartIndex = computed(() => {
  const active = activeRelativePath.value
  if (active === undefined) return -1
  return props.navigation.findIndex(item => item.kind === 'part' && item.chapters.includes(active))
})

watch([ activeRelativePath, currentPartIndex, project ], () => {
  const active = activeRelativePath.value
  if (newChapterPlacement.value === 'after-active' && (active === undefined || !project.value?.files.includes(active))) {
    newChapterPlacement.value = currentPartIndex.value >= 0 ? 'part-end' : 'book-end'
  } else if (newChapterPlacement.value === 'part-end' && currentPartIndex.value < 0) {
    newChapterPlacement.value = active !== undefined && project.value?.files.includes(active) ? 'after-active' : 'book-end'
  }
}, { immediate: true })

watch(omittedCandidates, candidates => {
  if (!candidates.some(candidate => candidate.relativePath === omittedChapter.value)) {
    omittedChapter.value = candidates[0]?.relativePath ?? ''
  }
}, { immediate: true })

watch(allMarkdownCandidates, candidates => {
  if (!candidates.some(candidate => candidate.relativePath === partChapter.value)) {
    const active = activeRelativePath.value
    partChapter.value = active !== undefined && candidates.some(candidate => candidate.relativePath === active)
      ? active
      : candidates[0]?.relativePath ?? ''
  }
}, { immediate: true })

function openPath (filePath: string|undefined, line = 1): void {
  if (filePath === undefined) {
    return
  }
  emit('jump', { filePath, line })
}

function placementAfterActive (): QuartoChapterPlacement {
  const active = activeRelativePath.value
  return active !== undefined && project.value?.files.includes(active)
    ? { kind: 'after-chapter', chapterPath: active }
    : { kind: 'book-end' }
}

function placementForNewChapter (): QuartoChapterPlacement {
  if (newChapterPlacement.value === 'part-end' && currentPartIndex.value >= 0) {
    return { kind: 'part-end', partIndex: currentPartIndex.value }
  }
  if (newChapterPlacement.value === 'after-active') {
    return placementAfterActive()
  }
  return { kind: 'book-end' }
}

async function editBook (edit: QuartoBookEdit): Promise<void> {
  try {
    // The refreshed book reaches this view as the root directory's FSAL change event.
    await window.ipc.invoke('application', {
      command: 'quarto-book-edit',
      payload: { rootPath: props.rootPath, edit }
    })
  } catch (err) {
    reportError('Could not edit the Quarto book', err)
    showToast(
      trans('Could not edit the Quarto book: %s', err instanceof Error ? err.message : String(err)),
      'error'
    )
  }
}

async function addSelectedChapter (): Promise<void> {
  if (omittedChapter.value === '') return
  const chapterPath = omittedChapter.value
  await editBook({ kind: 'add-chapter', chapterPath, placement: placementAfterActive() })
  omittedChapter.value = ''
}

async function createChapter (): Promise<void> {
  const name = newChapterName.value.trim()
  if (name === '') return
  const active = props.activeItem
  const placement = placementForNewChapter()
  const targetDirectory = active !== undefined && isInsideRoot(active, props.rootPath)
    ? pathDirname(active)
    : props.rootPath
  try {
    const created = await window.ipc.invoke('application', {
      command: 'file-new',
      payload: { path: targetDirectory, name }
    })
    if (created === undefined) return
    await editBook({
      kind: 'add-chapter',
      chapterPath: projectRelativePath(created, props.rootPath),
      placement
    })
    newChapterName.value = ''
  } catch (err) {
    reportError('Could not create a Quarto chapter', err)
    showToast(
      trans('Could not create a Quarto chapter: %s', err instanceof Error ? err.message : String(err)),
      'error'
    )
  }
}

async function addPart (): Promise<void> {
  const title = newPartTitle.value.trim()
  if (title === '' || partChapter.value === '') return
  await editBook({ kind: 'add-part', title, chapterPath: partChapter.value })
  newPartTitle.value = ''
}

function beginChapterDrag (filePath: string, event: DragEvent): void {
  draggedChapter.value = projectRelativePath(filePath, props.rootPath)
  if (event.dataTransfer !== null) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/x-zettlr-quarto-chapter', draggedChapter.value)
  }
}

function endChapterDrag (): void {
  draggedChapter.value = undefined
}

async function dropBefore (filePath: string): Promise<void> {
  const source = draggedChapter.value
  const target = projectRelativePath(filePath, props.rootPath)
  if (source === undefined || source === target) return
  await editBook({ kind: 'move-chapter', chapterPath: source, placement: { kind: 'before-chapter', chapterPath: target } })
  endChapterDrag()
}

async function dropIntoPart (partIndex: number): Promise<void> {
  const source = draggedChapter.value
  if (source === undefined) return
  await editBook({ kind: 'move-chapter', chapterPath: source, placement: { kind: 'part-end', partIndex } })
  endChapterDrag()
}

async function dropAtBookEnd (): Promise<void> {
  const source = draggedChapter.value
  if (source === undefined) return
  await editBook({ kind: 'move-chapter', chapterPath: source, placement: { kind: 'book-end' } })
  endChapterDrag()
}
</script>

<style lang="less">
body .quarto-book-outline {
  height: 100%;
  overflow-y: auto;
  font-size: var(--chrome-font-size);

  .book-controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 4px var(--chrome-inset);

    button {
      display: flex;
      align-items: center;
      gap: 3px;
      padding: 2px 6px;
      border: 1px solid var(--chrome-border);
      border-radius: 4px;
      background: transparent;
      color: var(--chrome-text);
      font: inherit;
      font-size: var(--chrome-section-font-size);
      cursor: pointer;

      &:disabled {
        color: var(--chrome-text-muted);
        cursor: default;
      }
    }

    .manage-book {
      margin-left: auto;
    }
  }

  .book-authoring {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 5px var(--chrome-inset) 7px;
    border-top: 1px solid var(--chrome-border);
    border-bottom: 1px solid var(--chrome-border);

    .authoring-row {
      display: flex;
      gap: 4px;

      input,
      select {
        min-width: 0;
        flex: 1 1 auto;
        height: 25px;
        border: 1px solid var(--chrome-border);
        border-radius: 3px;
        background: transparent;
        color: inherit;
        font: inherit;
      }

      button {
        flex: 0 0 auto;
      }
    }

    .authoring-hint {
      margin: 0;
      color: var(--chrome-text-muted);
      font-size: var(--chrome-section-font-size);
    }
  }

  .book-position {
    color: var(--chrome-text-muted);
    font-size: var(--chrome-section-font-size);
    font-variant-numeric: tabular-nums;
  }

  nav,
  .book-part {
    display: flex;
    flex-direction: column;
  }

  .part-drop-target {
    border-radius: 3px;
  }

  .part-drop-target:active,
  .part-drop-target:hover {
    background: var(--chrome-row-hover-bg);
  }

  .book-end-drop {
    margin: 4px var(--chrome-inset) 8px;
    padding: 6px;
    border: 1px dashed var(--chrome-border);
    border-radius: 4px;
    color: var(--chrome-text-muted);
    text-align: center;
  }

  button.chapter {
    width: 100%;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;

    .chapter-number {
      flex: 0 0 2em;
      font-variant-numeric: tabular-nums;
    }
  }
}
</style>
