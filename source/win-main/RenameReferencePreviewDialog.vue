<template>
  <Teleport to="body">
    <div
      class="rename-preview-backdrop"
      v-on:mousedown.self="emit('close')"
    >
      <div
        class="rename-preview-dialog"
        role="dialog"
        aria-modal="true"
        v-bind:aria-label="trans('Preview workspace rename')"
      >
        <h2>{{ trans('Rename across the workspace') }}</h2>
        <p class="identity">
          <code data-rename-old-key>{{ props.oldKey }}</code>
          <span class="arrow">→</span>
          <code data-rename-new-key>{{ props.newKey }}</code>
        </p>
        <p class="totals">
          {{ trans('%s occurrences across %s documents will change. Nothing changes until you apply.', totalEdits, props.files.length) }}
        </p>

        <ul class="file-list">
          <li
            v-for="file in props.files"
            v-bind:key="file.documentPath"
            v-bind:data-preview-path="file.documentPath"
            v-bind:data-preview-count="file.editCount"
          >
            <div class="file-head">
              <!-- dir=rtl ellipsizes the path's head; the bdi keeps the
                   ltr path text itself from being reordered. -->
              <span class="path" dir="rtl"><bdi>{{ file.documentPath }}</bdi></span>
              <span class="count">{{ occurrenceCount(file.editCount) }}</span>
            </div>
            <ul class="snippets">
              <li
                v-for="(snippet, index) in file.snippets"
                v-bind:key="index"
                class="snippet"
              >
                {{ snippet }}
              </li>
            </ul>
          </li>
        </ul>

        <div class="button-row">
          <button
            data-cancel
            v-on:click="emit('close')"
          >
            {{ trans('Cancel') }}
          </button>
          <button
            data-apply
            v-on:click="emit('apply')"
          >
            {{ trans('Apply all') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        RenameReferencePreviewDialog
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The workspace rename preview (issue #1, review A4;
 *                  US-17/IS-12: "Rename presents a complete preview …
 *                  applies atomically"; contract locked by
 *                  test/reference-rename-preview.spec.ts). Before anything
 *                  commits, the dialog lists every affected document with
 *                  its exact edit count and the authored context snippet of
 *                  every affected range. Cancel emits 'close' and commits
 *                  nothing; Apply emits exactly one 'apply' — the HOST
 *                  (MainEditor.vue) owns the actual hash-fenced atomic
 *                  commit and its Undo toast.
 *
 * END HEADER
 */
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { trans } from '@common/i18n-renderer'
import type { RenamePreviewFileSummary } from '@common/pandoc-util/compute-reference-edits'

const props = defineProps<{
  /** The full key being renamed */
  oldKey: string
  /** The full replacement key */
  newKey: string
  /** The previewed per-file summary (buildRenamePreviewSummary) */
  files: RenamePreviewFileSummary[]
}>()

const emit = defineEmits<{
  (e: 'apply'): void
  (e: 'close'): void
}>()

const totalEdits = computed<number>(() => {
  return props.files.reduce((sum, file) => sum + file.editCount, 0)
})

/**
 * The pluralized per-file occurrence count label.
 *
 * @param   {number}  count  The file's edit count
 *
 * @return  {string}         The display label
 */
function occurrenceCount (count: number): string {
  return count === 1 ? trans('1 occurrence') : trans('%s occurrences', count)
}

function handleKeydown (event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('close')
  }
}

onMounted(() => document.addEventListener('keydown', handleKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', handleKeydown))
</script>

<style lang="less">
.rename-preview-backdrop {
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

.rename-preview-dialog {
  --dialog-bg: #ffffff;
  --dialog-text: #24272b;
  --dialog-muted: #686d73;
  --dialog-border: #dedcd5;
  --dialog-accent: #315e86;
  --dialog-accent-soft: #e7eef5;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(620px, 100%);
  max-height: min(640px, 100%);
  overflow: auto;
  box-sizing: border-box;
  padding: 18px 20px;
  color: var(--dialog-text);
  background: var(--dialog-bg);
  border: 1px solid var(--dialog-border);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, .32);
  font: 13px/1.4 system-ui, sans-serif;

  h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }

  .identity {
    display: flex;
    gap: 8px;
    align-items: center;
    margin: 0;

    code {
      padding: 3px 8px;
      background: var(--dialog-accent-soft);
      border-radius: 6px;
      font: 500 12.5px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
    }

    .arrow { color: var(--dialog-muted); }
  }

  .totals {
    margin: 0;
    color: var(--dialog-muted);
    font-size: 12px;
  }

  .file-list {
    flex: 1 1 auto;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;

    > li {
      padding: 8px 0;
      border-top: 1px solid var(--dialog-border);
    }
  }

  .file-head {
    display: flex;
    gap: 10px;
    align-items: baseline;
    justify-content: space-between;

    .path {
      overflow: hidden;
      font-weight: 600;
      white-space: nowrap;
      text-overflow: ellipsis;
      text-align: left;
    }

    .count {
      flex: 0 0 auto;
      color: var(--dialog-muted);
      font-size: 11px;
    }
  }

  .snippets {
    margin: 4px 0 0;
    padding: 0;
    list-style: none;

    .snippet {
      overflow: hidden;
      margin-top: 2px;
      padding: 3px 8px;
      color: var(--dialog-muted);
      background: color-mix(in srgb, var(--dialog-accent-soft) 45%, transparent);
      border-radius: 5px;
      font: 11.5px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
  }

  .button-row {
    display: flex;
    justify-content: flex-end;
    gap: 8px;

    button {
      padding: 6px 14px;
      color: inherit;
      background: var(--dialog-bg);
      border: 1px solid var(--dialog-border);
      border-radius: 8px;
      font: inherit;
      cursor: pointer;

      &[data-apply] {
        color: #ffffff;
        background: var(--dialog-accent);
        border-color: var(--dialog-accent);
      }
    }
  }
}

body.dark .rename-preview-dialog {
  --dialog-bg: #2d3136;
  --dialog-text: #eef0f2;
  --dialog-muted: #aeb4bb;
  --dialog-border: #42474d;
  --dialog-accent: #8db9df;
  --dialog-accent-soft: #293d50;
}
</style>
