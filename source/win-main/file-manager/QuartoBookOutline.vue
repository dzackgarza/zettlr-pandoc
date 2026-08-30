<template>
  <section class="quarto-book-outline" aria-label="Book navigation">
    <header>
      <span>{{ bookLabel }}</span>
      <span class="book-position">{{ currentPosition }}</span>
    </header>
    <div class="book-controls">
      <button type="button" v-bind:disabled="previousPath === undefined" v-on:click.stop="openPath(previousPath)">
        <cds-icon shape="angle" direction="left"></cds-icon>
        {{ previousLabel }}
      </button>
      <button type="button" v-bind:disabled="nextPath === undefined" v-on:click.stop="openPath(nextPath)">
        {{ nextLabel }}
        <cds-icon shape="angle" direction="right"></cds-icon>
      </button>
    </div>
    <nav>
      <template v-for="item in outline.items" v-bind:key="item.kind === 'chapter' ? item.path : item.title">
        <button
          v-if="item.kind === 'chapter'"
          type="button"
          v-bind:class="{ chapter: true, active: item.path === activeItem }"
          v-on:click.stop="openPath(item.path)"
        >
          <span class="chapter-number">{{ item.position }}</span>
          <span>{{ item.title }}</span>
        </button>
        <section v-else class="book-part">
          <h4>{{ item.title }}</h4>
          <button
            v-for="chapter in item.chapters"
            v-bind:key="chapter.path"
            type="button"
            v-bind:class="{ chapter: true, active: chapter.path === activeItem }"
            v-on:click.stop="openPath(chapter.path)"
          >
            <span class="chapter-number">{{ chapter.position }}</span>
            <span>{{ chapter.title }}</span>
          </button>
        </section>
      </template>
    </nav>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { trans } from '@common/i18n-renderer'
import { pathBasename } from '@common/util/renderer-path-polyfill'
import type { ProjectNavigationItem } from '@dts/common/fsal'
import { useWorkspaceStore } from 'source/pinia'
import { buildQuartoBookOutline } from './quarto-book-outline'

const ipcRenderer = window.ipc
const workspaceStore = useWorkspaceStore()
const props = defineProps<{
  rootPath: string
  navigation: ProjectNavigationItem[]
  activeItem?: string
}>()

const bookLabel = trans('Book')
const previousLabel = trans('Previous')
const nextLabel = trans('Next')

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

function openPath (filePath: string|undefined): void {
  if (filePath === undefined) {
    return
  }
  ipcRenderer.invoke('documents-provider', {
    command: 'open-file',
    payload: { path: filePath }
  }).catch((error: Error) => console.error(error))
}
</script>

<style lang="less">
.quarto-book-outline {
  margin: 4px 8px 8px 24px;
  padding: 8px;
  border-left: 2px solid var(--system-accent-color);

  header,
  .book-controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  header {
    margin-bottom: 6px;
    font-weight: 600;
  }

  .book-position,
  .chapter-number {
    opacity: 0.65;
    font-variant-numeric: tabular-nums;
  }

  .book-controls {
    margin-bottom: 8px;

    button {
      display: flex;
      align-items: center;
      gap: 3px;
    }
  }

  nav,
  .book-part {
    display: flex;
    flex-direction: column;
  }

  .book-part h4 {
    margin: 9px 0 3px;
    font-size: 0.85em;
    opacity: 0.75;
  }

  .chapter {
    display: grid;
    grid-template-columns: 2em 1fr;
    gap: 4px;
    width: 100%;
    padding: 4px;
    border: 0;
    background: transparent;
    text-align: left;

    &:hover {
      background-color: rgb(220, 220, 220);
    }

    &.active {
      color: var(--system-accent-color);
      font-weight: 600;
    }
  }
}

body.dark .quarto-book-outline .chapter:hover {
  background-color: rgb(68, 68, 68);
}
</style>
