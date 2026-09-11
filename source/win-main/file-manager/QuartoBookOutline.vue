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
    </div>
    <nav>
      <template v-for="item in outline.items" v-bind:key="item.kind === 'chapter' ? item.path : item.title">
        <button
          v-if="item.kind === 'chapter'"
          type="button"
          v-bind:class="{ 'chrome-row': true, chapter: true, active: item.path === activeItem, 'chrome-row-active': item.path === activeItem }"
          v-on:click.stop="openPath(item.path, 1)"
        >
          <span class="chrome-row-detail chapter-number">{{ item.position }}</span>
          <span class="chrome-row-label">{{ item.title }}</span>
        </button>
        <section v-else-if="item.kind === 'part'" class="book-part">
          <h4 class="chrome-group-label">{{ item.title }}</h4>
          <button
            v-for="chapter in item.chapters"
            v-bind:key="chapter.path"
            type="button"
            v-bind:class="{ 'chrome-row': true, chapter: true, active: chapter.path === activeItem, 'chrome-row-active': chapter.path === activeItem }"
            v-on:click.stop="openPath(chapter.path, 1)"
          >
            <span class="chrome-row-detail chapter-number">{{ chapter.position }}</span>
            <span class="chrome-row-label">{{ chapter.title }}</span>
          </button>
        </section>
      </template>
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

import { computed } from 'vue'
import { trans } from '@common/i18n-renderer'
import { pathBasename } from '@common/util/renderer-path-polyfill'
import type { ProjectNavigationItem } from '@dts/common/fsal'
import { useWorkspaceStore } from 'source/pinia'
import { buildQuartoBookOutline } from './quarto-book-outline'

const workspaceStore = useWorkspaceStore()
const props = defineProps<{
  rootPath: string
  navigation: ProjectNavigationItem[]
  activeItem?: string
}>()
const emit = defineEmits<(event: 'jump', target: { filePath: string, line: number }) => void>()

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

function openPath (filePath: string|undefined, line = 1): void {
  if (filePath === undefined) {
    return
  }
  emit('jump', { filePath, line })
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
