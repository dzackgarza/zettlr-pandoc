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
          v-on:click.stop="openPath(item.path, 1)"
        >
          <span class="chapter-number">{{ item.position }}</span>
          <span>{{ item.title }}</span>
        </button>
        <div v-if="item.kind === 'chapter'" class="book-sections">
          <button
            v-for="section in sections[item.path]"
            v-bind:key="`${item.path}:${section.line}`"
            type="button"
            v-bind:style="{ 'padding-left': `${Math.max(0, section.level - 2) * 12 + 34}px` }"
            v-on:click.stop="openPath(item.path, section.line)"
          >
            {{ section.title }}
          </button>
        </div>
        <section v-else class="book-part">
          <h4>{{ item.title }}</h4>
          <div v-for="chapter in item.chapters" v-bind:key="chapter.path" class="book-chapter">
            <button
              type="button"
              v-bind:class="{ chapter: true, active: chapter.path === activeItem }"
              v-on:click.stop="openPath(chapter.path, 1)"
            >
              <span class="chapter-number">{{ chapter.position }}</span>
              <span>{{ chapter.title }}</span>
            </button>
            <div class="book-sections">
              <button
                v-for="section in sections[chapter.path]"
                v-bind:key="`${chapter.path}:${section.line}`"
                type="button"
                v-bind:style="{ 'padding-left': `${Math.max(0, section.level - 2) * 12 + 34}px` }"
                v-on:click.stop="openPath(chapter.path, section.line)"
              >
                {{ section.title }}
              </button>
            </div>
          </div>
        </section>
      </template>
    </nav>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { trans } from '@common/i18n-renderer'
import { pathBasename } from '@common/util/renderer-path-polyfill'
import type { ProjectNavigationItem } from '@dts/common/fsal'
import { useWorkspaceStore } from 'source/pinia'
import {
  buildQuartoBookOutline,
  extractQuartoBookSections,
  type QuartoBookSection
} from './quarto-book-outline'

const ipcRenderer = window.ipc
const workspaceStore = useWorkspaceStore()
const props = defineProps<{
  rootPath: string
  navigation: ProjectNavigationItem[]
  activeItem?: string
}>()
const emit = defineEmits<(event: 'jump', target: { filePath: string, line: number }) => void>()

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
const sections = ref<Record<string, QuartoBookSection[]>>({})

watch(() => outline.value.orderedPaths, async paths => {
  const loaded = await Promise.all(paths.map(async filePath => {
    const source: string = await ipcRenderer.invoke('application', {
      command: 'get-file-contents',
      payload: filePath
    })
    return [ filePath, extractQuartoBookSections(source) ] as const
  }))
  sections.value = Object.fromEntries(loaded)
}, { immediate: true })

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

function openPath (filePath: string|undefined, line = 1): void {
  if (filePath === undefined) {
    return
  }
  emit('jump', { filePath, line })
}
</script>

<style lang="less">
.quarto-book-outline {
  height: 100%;
  padding: 10px;
  overflow-y: auto;

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
  .book-part,
  .book-chapter,
  .book-sections {
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

  .book-sections button {
    border: 0;
    background: transparent;
    padding-top: 3px;
    padding-bottom: 3px;
    text-align: left;
    opacity: 0.8;

    &:hover {
      color: var(--system-accent-color);
      text-decoration: underline;
    }
  }
}

body.dark .quarto-book-outline .chapter:hover {
  background-color: rgb(68, 68, 68);
}
</style>
