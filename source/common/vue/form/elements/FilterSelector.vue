<template>
  <div class="filter-selector">
    <label v-if="label !== ''" class="fs-label">{{ label }}</label>
    <ul v-if="ordered.length > 0" class="fs-list">
      <li
        v-for="name in ordered"
        v-bind:key="name"
        class="fs-row"
        v-bind:class="{ 'fs-enabled': isEnabled(name) }"
      >
        <label class="fs-check">
          <input
            type="checkbox"
            v-bind:checked="isEnabled(name)"
            v-on:change="toggle(name)"
          >
          {{ name }}
        </label>
        <span v-if="isEnabled(name)" class="fs-reorder">
          <button type="button" v-bind:disabled="enabledIndex(name) === 0" v-on:click="move(name, -1)">↑</button>
          <button type="button" v-bind:disabled="enabledIndex(name) === modelValue.length - 1" v-on:click="move(name, 1)">↓</button>
        </span>
      </li>
    </ul>
    <p v-else class="fs-empty">No Lua filters found in ~/.pandoc/filters or the lua-filter directory.</p>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

const props = withDefaults(defineProps<{
  // The enabled export filter chain, in order (config.export.filters).
  modelValue: string[]
  label?: string
}>(), { label: '' })

const emit = defineEmits<(e: 'update:modelValue', value: string[]) => void>()

const ipcRenderer = window.ipc
const available = ref<string[]>([])

onMounted(async () => {
  const result = await ipcRenderer.invoke('assets-provider', { command: 'list-available-filters' })
  available.value = Array.isArray(result) ? result as string[] : []
})

// Enabled filters (in configured order) first, then the remaining available ones.
const ordered = computed<string[]>(() => {
  const disabled = available.value.filter(f => !props.modelValue.includes(f))
  return [ ...props.modelValue, ...disabled ]
})

function isEnabled (name: string): boolean {
  return props.modelValue.includes(name)
}

function enabledIndex (name: string): number {
  return props.modelValue.indexOf(name)
}

function toggle (name: string): void {
  emit('update:modelValue', isEnabled(name)
    ? props.modelValue.filter(f => f !== name)
    : [ ...props.modelValue, name ])
}

function move (name: string, delta: number): void {
  const arr = [ ...props.modelValue ]
  const i = arr.indexOf(name)
  const j = i + delta
  if (i < 0 || j < 0 || j >= arr.length) {
    return
  }
  const tmp = arr[i]
  arr[i] = arr[j]
  arr[j] = tmp
  emit('update:modelValue', arr)
}
</script>

<style>
.filter-selector .fs-label { display: block; margin-bottom: 4px; }
.filter-selector .fs-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid rgba(127, 127, 127, 0.3);
  border-radius: 4px;
}
.filter-selector .fs-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 3px 8px;
}
.filter-selector .fs-row.fs-enabled { background-color: rgba(60, 130, 240, 0.1); }
.filter-selector .fs-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: monospace;
  font-size: 12px;
  cursor: pointer;
}
.filter-selector .fs-reorder button {
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 0 3px;
  opacity: 0.7;
}
.filter-selector .fs-reorder button:disabled { opacity: 0.2; cursor: default; }
.filter-selector .fs-empty { font-size: 11px; color: rgba(127, 127, 127, 1); }
</style>
