<template>
  <Teleport to="body">
    <div
      class="create-reference-label-backdrop"
      v-on:mousedown.self="emit('close')"
    >
      <div
        class="create-reference-label-dialog"
        role="dialog"
        aria-modal="true"
        v-bind:aria-label="trans('Create reference label')"
      >
        <h2>{{ trans('Create %s label', familyDisplayName) }}</h2>
        <div class="key-row">
          <span data-family-prefix>{{ props.family }}:</span>
          <input
            ref="slugInput"
            v-model="slug"
            type="text"
            spellcheck="false"
            v-bind:aria-label="trans('Label key')"
            v-on:keydown="handleKeydown"
          >
        </div>
        <p
          class="uniqueness"
          v-bind:data-uniqueness="uniqueness"
        >
          {{ uniquenessMessage }}
        </p>
        <div class="button-row">
          <button v-on:click="emit('close')">
            {{ trans('Cancel') }}
          </button>
          <button
            data-confirm
            v-bind:disabled="confirmDisabled"
            v-on:click="confirm()"
          >
            {{ trans('Create label') }}
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
 * Contains:        CreateReferenceLabelDialog
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The Create-reference-label dialog (issue #1 Phase 6,
 *                  workstream 3; contract locked by
 *                  test/reference-create-label.spec.ts). The family prefix is
 *                  FIXED by the invoking context and never editable; the slug
 *                  input autofocuses holding the proposed slug; the live
 *                  workspace-uniqueness verdict of family + ':' + slug is
 *                  reported against the supplied existingKeys (the host
 *                  fetches them over the reference-provider 'get-snapshot'
 *                  ipc command); confirmation is blocked while the key is
 *                  taken or the slug is empty. Confirming emits exactly one
 *                  'create' intent { key, insertText, clipboardText } —
 *                  insertion position, clipboard write, and toast are
 *                  host-owned.
 *
 * END HEADER
 */

/**
 * The single intent emitted on confirmation lives beside the request/effect
 * types in the create-reference-label plugin module (a plain TS module all
 * hosts resolve identically); it is re-exported here for dialog consumers.
 */
export type { CreateReferenceLabelIntent } from '@common/modules/markdown-editor/plugins/create-reference-label'
</script>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { trans } from '@common/i18n-renderer'
import { referenceFamilyDisplayName, type ReferenceFamily } from '@dts/common/references'
import type { CreateReferenceLabelIntent } from '@common/modules/markdown-editor/plugins/create-reference-label'

const props = defineProps<{
  /** The family fixed by the invoking context (never editable) */
  family: ReferenceFamily
  /** The editable initial slug proposal */
  proposedSlug: string
  /** Every workspace definition key, for the live uniqueness verdict */
  existingKeys: string[]
}>()

const emit = defineEmits<{
  (e: 'create', intent: CreateReferenceLabelIntent): void
  (e: 'close'): void
}>()

const slug = ref<string>(props.proposedSlug)
const slugInput = ref<HTMLInputElement|null>(null)

const familyDisplayName = computed<string>(() => referenceFamilyDisplayName(props.family))

/** The full key the dialog is currently proposing */
const key = computed<string>(() => `${props.family}:${slug.value}`)

/** The live workspace-uniqueness verdict of the current key */
const uniqueness = computed<'taken'|'available'>(() => {
  return props.existingKeys.includes(key.value) ? 'taken' : 'available'
})

const confirmDisabled = computed<boolean>(() => {
  return slug.value === '' || uniqueness.value === 'taken'
})

const uniquenessMessage = computed<string>(() => {
  if (slug.value === '') {
    return trans('Enter a label key')
  }

  return uniqueness.value === 'taken'
    ? trans('%s is already defined in this workspace', key.value)
    : trans('%s is available', key.value)
})

/**
 * Emits the single create intent for the current (available) key.
 */
function confirm (): void {
  if (confirmDisabled.value) {
    return
  }

  emit('create', {
    key: key.value,
    insertText: '#' + key.value,
    clipboardText: '@' + key.value
  })
}

/**
 * Keyboard interface of the slug input: Enter confirms when the key is
 * available, Escape closes the dialog without any intent.
 *
 * @param   {KeyboardEvent}  event  The keydown event
 */
function handleKeydown (event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault()
    confirm()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  }
}

onMounted(() => {
  // Autofocus with the caret at the end of the proposal so real keyboard
  // input appends to the editable slug.
  const input = slugInput.value
  if (input !== null) {
    input.focus()
    const end = input.value.length
    input.setSelectionRange(end, end)
  }
})
</script>

<style lang="less">
.create-reference-label-backdrop {
  position: fixed;
  inset: 0;
  z-index: 400;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  box-sizing: border-box;
  padding: clamp(24px, 16vh, 160px) 16px 24px;
  background: rgba(14, 18, 24, .38);
  backdrop-filter: blur(3px);
}

.create-reference-label-dialog {
  --dialog-bg: #ffffff;
  --dialog-text: #24272b;
  --dialog-muted: #686d73;
  --dialog-border: #dedcd5;
  --dialog-accent: #315e86;
  --dialog-accent-soft: #e7eef5;
  --dialog-taken: #a13c2f;
  --dialog-available: #2d6a4f;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(440px, 100%);
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

  .key-row {
    display: flex;
    align-items: center;
    gap: 0;
    border: 1px solid var(--dialog-border);
    border-radius: 8px;
    overflow: hidden;

    [data-family-prefix] {
      flex: 0 0 auto;
      padding: 8px 4px 8px 10px;
      color: var(--dialog-muted);
      background: var(--dialog-accent-soft);
      font: 500 13px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
    }

    input {
      flex: 1 1 auto;
      box-sizing: border-box;
      min-width: 0;
      margin: 0;
      padding: 8px 10px 8px 4px;
      color: inherit;
      background: transparent;
      border: none;
      border-radius: 0;
      font: 500 13px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
      outline: none;
    }
  }

  .uniqueness {
    margin: 0;
    font-size: 12px;

    &[data-uniqueness="taken"] { color: var(--dialog-taken); }
    &[data-uniqueness="available"] { color: var(--dialog-available); }
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

      &[data-confirm] {
        color: #ffffff;
        background: var(--dialog-accent);
        border-color: var(--dialog-accent);
      }

      &:disabled {
        opacity: .5;
        cursor: not-allowed;
      }
    }
  }
}

body.dark .create-reference-label-dialog {
  --dialog-bg: #2d3136;
  --dialog-text: #eef0f2;
  --dialog-muted: #aeb4bb;
  --dialog-border: #42474d;
  --dialog-accent: #8db9df;
  --dialog-accent-soft: #293d50;
  --dialog-taken: #e39288;
  --dialog-available: #8fd0b2;
}
</style>
