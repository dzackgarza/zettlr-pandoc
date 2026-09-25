<template>
  <form
    class="launcher-view just-recipe-arguments"
    data-just-recipe-arguments
    v-on:submit.prevent="submit"
  >
    <div class="launcher-query-row">
      <span class="launcher-breadcrumb">{{ breadcrumb }}</span>
      <input
        ref="input"
        class="launcher-input"
        data-command-launcher-input
        v-bind:value="props.query"
        v-bind:placeholder="placeholder"
        v-on:input="onInput"
        v-on:keydown.backspace="onBackspace"
        v-on:keydown.escape.prevent.stop="emit('close')"
      >
    </div>
    <div class="launcher-list just-recipe-arguments-help">
      <div class="chrome-row">
        <span class="chrome-row-label">{{ signature }}</span>
      </div>
      <div v-if="props.recipe.doc !== null" class="just-recipe-doc">
        {{ props.recipe.doc }}
      </div>
      <div class="just-recipe-hint">
        Quotes and backslash escapes are supported. Shell operators are not executed.
      </div>
      <div v-if="error !== ''" class="just-recipe-error">
        {{ error }}
      </div>
    </div>
  </form>
</template>

<script setup lang="ts">
import { reportError } from '@common/util/error-reporting'
import { computed, nextTick, onMounted, ref } from 'vue'
import { trans } from '@common/i18n-renderer'
import type { JustRecipeRow } from './launcher-rows'
import { parseJustArguments } from './just-arguments'

const props = defineProps<{
  recipe: JustRecipeRow
  query: string
}>()

const emit = defineEmits<{
  (e: 'update:query', query: string): void
  (e: 'run', args: string[]): void
  (e: 'back'): void
  (e: 'close'): void
}>()

const input = ref<HTMLInputElement|null>(null)
const error = ref('')

const breadcrumb = computed(() => [
  trans('Justfile commands'),
  props.recipe.repoLabel,
  props.recipe.name
].join(' › '))

const signature = computed(() => `just ${props.recipe.label}`)
const placeholder = computed(() => trans('Arguments for %s…', props.recipe.name))

onMounted(() => {
  nextTick().then(() => { input.value?.focus() }).catch(err => reportError(err))
})

function onInput (event: Event): void {
  if (event.target instanceof HTMLInputElement) {
    error.value = ''
    emit('update:query', event.target.value)
  }
}

function onBackspace (): void {
  if (props.query === '') {
    emit('back')
  }
}

function submit (): void {
  try {
    emit('run', parseJustArguments(props.query))
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}
</script>

<style lang="less">
.command-launcher {
  .just-recipe-arguments-help {
    padding-bottom: 12px;
  }

  .just-recipe-doc,
  .just-recipe-hint,
  .just-recipe-error {
    padding: 6px 16px 0;
    color: var(--chrome-text-muted);
  }

  .just-recipe-error {
    color: var(--chrome-danger-text, var(--chrome-text));
  }
}
</style>
