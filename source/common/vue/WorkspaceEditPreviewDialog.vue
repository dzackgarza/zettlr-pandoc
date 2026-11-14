<template>
  <Teleport to="body">
    <div
      class="workspace-edit-backdrop"
      v-on:mousedown.self="emit('cancel')"
    >
      <div
        class="workspace-edit-preview self-painted-controls"
        role="dialog"
        aria-modal="true"
        v-bind:aria-label="props.title"
      >
        <h2>{{ props.title }}</h2>
        <slot name="identity"></slot>
        <p class="description">
          {{ props.description }}
        </p>
        <p class="totals">
          {{ totals }}
        </p>

        <ul class="document-list">
          <li
            v-for="document in props.documents"
            v-bind:key="document.documentPath"
            v-bind:data-preview-path="document.documentPath"
          >
            <!-- dir=rtl ellipsizes the head of the path; the bdi keeps the
                 ltr path text itself from being reordered. -->
            <div class="path" dir="rtl" v-bind:title="document.documentPath">
              <bdi>{{ document.documentPath }}</bdi>
            </div>
            <ol class="changes">
              <li
                v-for="change in document.changes"
                v-bind:key="change.line"
                data-preview-change
              >
                <span class="line-number">{{ change.line }}</span>
                <div class="lines">
                  <pre class="before" data-preview-before>{{ change.before }}</pre>
                  <pre class="after" data-preview-after>{{ change.after }}</pre>
                </div>
              </li>
            </ol>
          </li>
        </ul>

        <div class="button-row">
          <button
            type="button"
            data-cancel
            v-on:click="emit('cancel')"
          >
            {{ trans('Cancel') }}
          </button>
          <button
            ref="applyButton"
            type="button"
            data-apply
            v-on:click="emit('apply')"
          >
            {{ trans('Apply') }}
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
 * Contains:        WorkspaceEditPreviewDialog
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The preview of an edit of several documents (#6): each
 *                  document, and each changed run of its lines before and
 *                  after. Nothing changes until the author applies. Apply
 *                  emits 'apply'; Cancel, Escape and a click outside the
 *                  dialog emit 'cancel'. The host owns the apply.
 *
 * END HEADER
 */
</script>

<script setup lang="ts">
import { trans } from '@common/i18n-renderer'
import type { WorkspaceEditDocumentPreview } from '@dts/common/workspace-edit'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{
  /** What the edit does, in a few words */
  title: string
  /** The action that caused the edit */
  description: string
  /** The documents, in the order of the preview */
  documents: WorkspaceEditDocumentPreview[]
}>()

const emit = defineEmits<{
  (e: 'apply'): void
  (e: 'cancel'): void
}>()

const applyButton = ref<HTMLButtonElement | null>(null)

const totals = computed<string>(() => {
  const changes = props.documents.reduce((sum, document) => sum + document.changes.length, 0)
  const lines = changes === 1 ? trans('1 changed line') : trans('%s changed lines', changes)
  return props.documents.length === 1
    ? trans('%s in 1 document', lines)
    : trans('%s in %s documents', lines, props.documents.length)
})

function handleKeydown (event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('cancel')
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
  applyButton.value?.focus()
})
onBeforeUnmount(() => document.removeEventListener('keydown', handleKeydown))
</script>

<style lang="less">
.workspace-edit-backdrop {
  position: fixed;
  inset: 0;
  z-index: 400;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  box-sizing: border-box;
  padding: clamp(24px, 10vh, 100px) 16px 24px;
  background: rgba(14, 18, 24, .38);
  backdrop-filter: blur(3px);
}

.workspace-edit-preview {
  --dialog-bg: #ffffff;
  --dialog-text: #24272b;
  --dialog-muted: #686d73;
  --dialog-border: #dedcd5;
  --dialog-accent: #315e86;
  --dialog-accent-soft: #e7eef5;
  --dialog-removed: #fbe9e7;
  --dialog-removed-mark: #a8382a;
  --dialog-added: #e6f4ea;
  --dialog-added-mark: #2e7445;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(760px, 100%);
  max-height: 100%;
  box-sizing: border-box;
  padding: 18px 20px;
  color: var(--dialog-text);
  background: var(--dialog-bg);
  border: 1px solid var(--dialog-border);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, .32);
  font: 14px/1.4 system-ui, sans-serif;

  h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }

  // The slot 'identity' names what the edit renames: a paragraph with the
  // class 'identity', its names in code elements and an arrow between them.
  .identity {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin: 0;

    code {
      padding: 3px 8px;
      background: var(--dialog-accent-soft);
      border-radius: 6px;
      font: 500 12.5px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
      overflow-wrap: anywhere;
    }

    .arrow { color: var(--dialog-muted); }
  }

  .description {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .totals {
    margin: 0;
    color: var(--dialog-muted);
  }

  .document-list {
    flex: 1 1 auto;
    min-height: 0;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;

    > li {
      padding: 8px 0;
      border-top: 1px solid var(--dialog-border);
    }
  }

  .path {
    overflow: hidden;
    font-weight: 600;
    white-space: nowrap;
    text-overflow: ellipsis;
    text-align: left;
  }

  .changes {
    margin: 6px 0 0;
    padding: 0;
    list-style: none;

    > li {
      display: flex;
      gap: 8px;
      margin-top: 4px;
    }
  }

  .line-number {
    flex: 0 0 3.5em;
    padding-top: 2px;
    color: var(--dialog-muted);
    font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
    text-align: right;
  }

  .lines {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    border: 1px solid var(--dialog-border);
    border-radius: 6px;
  }

  pre {
    margin: 0;
    padding: 2px 8px 2px 22px;
    font: 12.5px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    position: relative;

    &::before {
      position: absolute;
      left: 8px;
      font-weight: 600;
    }

    // A run of lines that the edit adds or removes as a whole has one empty side.
    &:empty { display: none; }
  }

  .before {
    background: var(--dialog-removed);
    &::before { content: '−'; color: var(--dialog-removed-mark); }
  }

  .after {
    background: var(--dialog-added);
    &::before { content: '+'; color: var(--dialog-added-mark); }
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

      &:focus-visible {
        outline: 2px solid var(--dialog-accent);
        outline-offset: 2px;
      }

      &[data-apply] {
        color: #ffffff;
        background: var(--dialog-accent);
        border-color: var(--dialog-accent);
      }
    }
  }
}

body.dark .workspace-edit-preview {
  --dialog-bg: #2d3136;
  --dialog-text: #eef0f2;
  --dialog-muted: #aeb4bb;
  --dialog-border: #42474d;
  --dialog-accent: #8db9df;
  --dialog-accent-soft: #293d50;
  --dialog-removed: #4a2a27;
  --dialog-removed-mark: #f1a196;
  --dialog-added: #23402c;
  --dialog-added-mark: #94d3a5;

  .button-row button[data-apply] { color: #10202e; }
}
</style>
