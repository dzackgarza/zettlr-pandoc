<template>
  <span
    ref="host"
    class="tikz-visual-label"
  />
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikZ visual-canvas label renderer
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Renders node text through Zettlr's already initialized
 *                  MathJax projection when the complete label is math, and
 *                  otherwise displays the authored source as plain text.
 *
 * END HEADER
 */

import { onMounted, ref, watch } from 'vue'
import { mathJaxToElem } from '@common/util/mathtex-to-html'
import { stripMathDelimiters } from '@common/util/math-delimiters'

const props = defineProps<{ label: string }>()
const host = ref<HTMLElement|null>(null)

function render (): void {
  const target = host.value
  if (target === null) return
  const math = stripMathDelimiters(props.label.trim())
  if (math === null) {
    target.textContent = props.label
    return
  }
  try {
    mathJaxToElem(math.equation, target, 'inline')
  } catch {
    // MathJax bootstrapping belongs to the application. If the visual provider
    // is mounted during an early test/boot edge, authored source is still a
    // truthful fallback rather than an empty label.
    target.textContent = props.label
  }
}

onMounted(render)
watch(() => props.label, render)
</script>

<style scoped>
.tikz-visual-label {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
  line-height: 1.1;
  pointer-events: none;
}

.tikz-visual-label :deep(mjx-container) {
  margin: 0;
}
</style>
