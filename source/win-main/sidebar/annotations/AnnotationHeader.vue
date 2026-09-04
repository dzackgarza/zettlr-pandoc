<template>
  <div class="annotations-header">
    <h1>
      {{ headingLabel }}
      <small class="annotation-open-count">({{ openCount }})</small>
    </h1>
    <div class="annotations-header-controls">
      <button
        type="button"
        class="annotations-filter-toggle"
        v-bind:class="{ active: filterOpen }"
        v-bind:title="filterLabel"
        v-bind:aria-label="filterLabel"
        v-on:click="filterOpen = !filterOpen"
      >
        <cds-icon shape="filter" role="presentation"></cds-icon>
      </button>
    </div>
    <input
      v-if="filterOpen"
      v-bind:value="query"
      type="search"
      class="annotations-filter-input"
      v-bind:placeholder="filterLabel"
      v-on:input="emit('update:query', ($event.target as HTMLInputElement).value)"
    >
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        AnnotationHeader
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     "OPEN ANNOTATIONS (N)" (S10: open-only) plus the panel's
 *                  filter affordance. The count prop is the single source
 *                  both this header and the sidebar tab badge read — both
 *                  are openAnnotationCount() of the same annotation list.
 *
 * END HEADER
 */

import { trans } from '@common/i18n-renderer'
import { ref } from 'vue'

defineProps<{
  openCount: number
  query: string
}>()

const emit = defineEmits<(e: 'update:query', value: string) => void>()

const filterOpen = ref(false)
const headingLabel = trans('Open annotations')
const filterLabel = trans('Filter annotations')
</script>

<style lang="less">
body {
  .annotations-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 4px;

    h1 {
      flex-grow: 1;
      margin: 10px 0;

      .annotation-open-count {
        font-size: 70%;
        font-weight: normal;
        opacity: 0.7;
      }
    }

    .annotations-header-controls {
      display: flex;
      gap: 2px;
    }

    .annotations-filter-toggle {
      border: none;
      background: transparent;
      border-radius: 4px;
      padding: 2px;
      cursor: pointer;

      &.active, &:hover { background-color: rgba(0, 0, 0, 0.08); }

      clr-icon, cds-icon { width: 14px; height: 14px; }
    }

    .annotations-filter-input {
      flex-basis: 100%;
      box-sizing: border-box;
      padding: 4px 6px;
      border-radius: 4px;
      border: 1px solid rgba(0, 0, 0, 0.15);
    }
  }

  &.dark .annotations-header .annotations-filter-toggle:hover {
    background-color: rgba(255, 255, 255, 0.12);
  }
}
</style>
