<template>
  <Teleport to="body">
    <div
      class="reference-search-overlay-backdrop"
      v-on:mousedown.self="emit('close')"
    >
      <div
        class="reference-search-overlay"
        role="dialog"
        aria-modal="true"
        v-bind:aria-label="trans('Search workspace definitions')"
      >
        <input
          ref="queryInput"
          v-model="query"
          type="text"
          v-bind:placeholder="trans('Search workspace definitions…')"
          v-bind:aria-label="trans('Definition search query')"
          v-on:keydown="handleKeydown"
        >
        <ul
          v-if="matches.length > 0"
          class="results"
          role="listbox"
        >
          <li
            v-for="(definition, index) in matches"
            v-bind:key="`${definition.documentPath}:${definition.key}:${definition.range.from}`"
            v-bind:class="{ result: true, selected: index === selectedIndex }"
            v-bind:data-reference-key="definition.key"
            v-bind:data-reference-path="definition.documentPath"
            role="option"
            v-bind:aria-selected="index === selectedIndex"
            v-on:click="emitJump(definition)"
          >
            <span class="type-title">{{ typeAndTitle(definition) }}</span>
            <span class="key">{{ definition.key }}</span>
            <span class="path">{{ definition.documentPath }}</span>
          </li>
        </ul>
        <p v-else class="no-results">
          {{ trans('No matching definitions') }}
        </p>
      </div>
    </div>
  </Teleport>
</template>

<script lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ReferenceSearchOverlay
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The Mod-P workspace reference search overlay (issue #1
 *                  Phase 3b; contract locked by
 *                  test/reference-search-overlay.spec.ts). Receives the full
 *                  workspace definition list, ranks it with
 *                  searchWorkspaceDefinitions() as the user types in the
 *                  autofocused query input, and emits a 'jump' intent
 *                  ({ key, documentPath, range }) for the selected definition
 *                  on Enter or click. ArrowUp/ArrowDown move the selection;
 *                  Escape (or a backdrop click) emits 'close'.
 *
 * END HEADER
 */

/**
 * The navigation intent emitted for a chosen definition. The
 * documents-provider open-file + selection jump precision lands in Phase 5;
 * the intent object is the contract surface now.
 */
export interface ReferenceJumpIntent {
  key: string
  documentPath: string
  range: { from: number, to: number }
}
</script>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { trans } from '@common/i18n-renderer'
import { searchWorkspaceDefinitions } from '@common/modules/markdown-editor/util/reference-search'
import type { ReferenceDefinition } from '@dts/common/references'
import { THEOREM_DIV_PREFIXES } from '@common/util/pandoc-quick-reference'

const props = defineProps<{ definitions: ReferenceDefinition[] }>()

const emit = defineEmits<{
  (e: 'jump', intent: ReferenceJumpIntent): void
  (e: 'close'): void
}>()

const query = ref<string>('')
const selectedIndex = ref<number>(0)
const queryInput = ref<HTMLInputElement|null>(null)

const matches = computed<ReferenceDefinition[]>(() => {
  return searchWorkspaceDefinitions(props.definitions, query.value)
})

// A new query re-ranks the rows, so the selection restarts at the top match.
watch(query, () => { selectedIndex.value = 0 })

const CROSSREF_LABELS: Record<string, string> = {
  fig: 'Figure',
  tbl: 'Table',
  eq: 'Equation',
  sec: 'Section',
  lst: 'Listing'
}

/**
 * Returns the human-readable type of a definition: the crossref object name
 * for attribute families, or the capitalized theorem-div class otherwise.
 *
 * @param   {ReferenceDefinition}  definition  The definition
 *
 * @return  {string}                           The display type
 */
function familyLabel (definition: ReferenceDefinition): string {
  const crossref = CROSSREF_LABELS[definition.family]
  if (crossref !== undefined) {
    return crossref
  }

  const divClass: string = THEOREM_DIV_PREFIXES[definition.family as keyof typeof THEOREM_DIV_PREFIXES]
  return divClass.charAt(0).toUpperCase() + divClass.slice(1)
}

/**
 * Returns the row headline: `Type — title`, or just the type when nothing
 * was authored as a title.
 *
 * @param   {ReferenceDefinition}  definition  The definition
 *
 * @return  {string}                           The row headline
 */
function typeAndTitle (definition: ReferenceDefinition): string {
  return definition.title === undefined
    ? familyLabel(definition)
    : `${familyLabel(definition)} — ${definition.title}`
}

/**
 * Emits the jump intent for a definition as a plain (non-reactive) object.
 *
 * @param   {ReferenceDefinition}  definition  The chosen definition
 */
function emitJump (definition: ReferenceDefinition): void {
  emit('jump', {
    key: definition.key,
    documentPath: definition.documentPath,
    range: { from: definition.range.from, to: definition.range.to }
  })
}

/**
 * Keyboard interface of the query input: ArrowUp/ArrowDown move the
 * selection, Enter emits the jump intent for the selected row, Escape
 * closes the overlay.
 *
 * @param   {KeyboardEvent}  event  The keydown event
 */
function handleKeydown (event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (selectedIndex.value < matches.value.length - 1) {
      selectedIndex.value += 1
    }
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    if (selectedIndex.value > 0) {
      selectedIndex.value -= 1
    }
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const selected = matches.value[selectedIndex.value]
    if (selected !== undefined) {
      emitJump(selected)
    }
  } else if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  }
}

onMounted(() => { queryInput.value?.focus() })
</script>

<style lang="less">
.reference-search-overlay-backdrop {
  position: fixed;
  inset: 0;
  z-index: 400;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  box-sizing: border-box;
  padding: clamp(24px, 12vh, 120px) 16px 24px;
  background: rgba(14, 18, 24, .38);
  backdrop-filter: blur(3px);
}

.reference-search-overlay {
  --search-bg: #ffffff;
  --search-text: #24272b;
  --search-muted: #686d73;
  --search-border: #dedcd5;
  --search-accent: #315e86;
  --search-accent-soft: #e7eef5;
  display: flex;
  flex-direction: column;
  width: min(640px, 100%);
  max-height: min(560px, 100%);
  overflow: hidden;
  box-sizing: border-box;
  color: var(--search-text);
  background: var(--search-bg);
  border: 1px solid var(--search-border);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, .32);
  font: 13px/1.4 system-ui, sans-serif;

  input {
    flex: 0 0 auto;
    box-sizing: border-box;
    width: 100%;
    margin: 0;
    padding: 13px 16px;
    color: inherit;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--search-border);
    border-radius: 0;
    font: inherit;
    font-size: 15px;
    outline: none;

    &::placeholder { color: var(--search-muted); }
  }

  .results {
    flex: 1 1 auto;
    margin: 0;
    padding: 6px;
    overflow-y: auto;
    list-style: none;
  }

  .result {
    display: grid;
    gap: 1px;
    padding: 7px 10px;
    border-radius: 8px;
    cursor: pointer;

    &:hover { background: color-mix(in srgb, var(--search-accent-soft) 55%, transparent); }

    &.selected {
      background: var(--search-accent-soft);
      box-shadow: inset 2px 0 0 var(--search-accent);
    }
  }

  .type-title {
    overflow: hidden;
    color: var(--search-muted);
    font-size: 11px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .key {
    overflow: hidden;
    font: 500 12.5px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .path {
    overflow: hidden;
    color: var(--search-muted);
    font-size: 11px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .no-results {
    margin: 0;
    padding: 18px 16px;
    color: var(--search-muted);
    text-align: center;
  }
}

body.dark .reference-search-overlay {
  --search-bg: #2d3136;
  --search-text: #eef0f2;
  --search-muted: #aeb4bb;
  --search-border: #42474d;
  --search-accent: #8db9df;
  --search-accent-soft: #293d50;
}
</style>
