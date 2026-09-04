<template>
  <Teleport to="body">
    <div
      class="annotation-create-backdrop"
      v-on:mousedown.self="cancel()"
    >
      <div
        class="annotation-create-dialog"
        role="dialog"
        aria-modal="true"
        v-bind:aria-label="trans('AI Annotation')"
        v-on:keydown="handleDialogKeydown"
      >
        <div class="header">
          <h2>{{ trans('AI Annotation') }}</h2>
          <button
            data-close
            v-bind:aria-label="trans('Cancel')"
            v-on:click="cancel()"
          >
            &times;
          </button>
        </div>

        <div class="field">
          <span class="field-label">{{ trans('Excerpt') }}</span>
          <blockquote
            class="excerpt"
            data-excerpt
            v-bind:class="{ stale: draftAnchor.state !== 'range' }"
            v-html="excerptHtml"
          />
          <p
            v-if="draftAnchor.state !== 'range'"
            class="stale-notice"
            data-stale-notice
          >
            {{ trans('The selected text was deleted. Cancel and reselect to annotate.') }}
          </p>
        </div>

        <div class="field">
          <label
            class="field-label"
            for="annotation-instruction"
          >{{ trans('Instruction for AI') }}</label>
          <textarea
            id="annotation-instruction"
            ref="instructionInput"
            v-model="instruction"
            data-instruction
            v-bind:maxlength="MAX_INSTRUCTION_LENGTH"
            v-bind:placeholder="trans('What should the AI do with this text?')"
            v-on:keydown="handleInstructionKeydown"
          />
          <span
            class="counter"
            data-counter
          >{{ instruction.length }}/{{ MAX_INSTRUCTION_LENGTH }}</span>
        </div>

        <p
          v-if="refusalMessage !== null"
          class="refusal"
          data-refusal
        >
          {{ refusalMessage }}
        </p>

        <div class="button-row">
          <button
            data-cancel
            v-on:click="cancel()"
          >
            {{ trans('Cancel') }}
          </button>
          <button
            data-save
            v-bind:disabled="!canSave"
            v-on:click="save()"
          >
            {{ trans('Save annotation') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        AnnotationCreateDialog
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The selection creation composer (M6; mockup 2; plan
 *                  section 2 S11). Exactly two fields — a read-only excerpt
 *                  and one instruction input — plus Cancel and Save
 *                  annotation. No title, category, assignee, or priority
 *                  field: the instruction IS the annotation's first message
 *                  (S6, I8), so there is nothing else to collect.
 *
 *                  "Anchored to the selection" (the M6 milestone Result) is
 *                  the draft's ANCHOR, not its screen position: while this
 *                  dialog is open, an owner edit anywhere in the document
 *                  can move or shrink the drafted range before Save ever
 *                  runs. draftAnchor tracks that live, the same way a
 *                  persisted annotation's anchor is carried across edits
 *                  (source/common/util/annotation-anchors.ts,
 *                  mapAnnotationThroughChanges) — except the draft has no
 *                  sidecar entry yet, so nothing in the transaction pipeline
 *                  maps it; this component is the only thing that does,
 *                  for as long as it stays mounted. It does this by
 *                  appending its own EditorView.updateListener onto the
 *                  live view via a runtime Compartment (the standard CM6
 *                  pattern for a feature scoped to one component's
 *                  lifetime), and removing it again on unmount — it never
 *                  touches the annotation decoration plugin or its
 *                  compartments.
 *
 *                  Save posts through documents:create-annotation
 *                  (CollaborationApplicationService's owner-only creation
 *                  pipeline); this component holds no annotation state of
 *                  its own beyond the draft anchor and the instruction text.
 *
 * END HEADER
 */

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Compartment, StateEffect } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { trans } from '@common/i18n-renderer'
import { md2html } from '@common/modules/markdown-utils'
import { mapAnnotationThroughChanges } from '@common/util/annotation-anchors'
import { CITEPROC_MAIN_DB } from '@dts/common/citeproc'
import type { AnnotationAnchor, TextAnnotation } from '@dts/common/annotation-domain'
import type { AnnotationFailure } from 'source/app/service-providers/documents/document-collaboration-application-service'

const MAX_INSTRUCTION_LENGTH = 500

const props = defineProps<{
  /** The live CodeMirror view the selection was taken from. */
  editorView: EditorView
  /** The document the annotation belongs to. */
  documentPath: string
  from: number
  to: number
  quotedText: string
  /** The session's current annotationGeneration, fenced against on Save. */
  annotationGeneration: number
}>()

const emit = defineEmits<{
  (e: 'saved', annotation: TextAnnotation): void
  (e: 'close'): void
}>()

const instruction = ref<string>('')
const instructionInput = ref<HTMLTextAreaElement|null>(null)
const saving = ref<boolean>(false)
const refusalMessage = ref<string|null>(null)
const excerptHtml = ref<string>('')

const draftAnchor = ref<AnnotationAnchor>({
  state: 'range',
  from: props.from,
  to: props.to,
  quotedText: props.quotedText
})

const canSave = computed<boolean>(() => {
  return draftAnchor.value.state === 'range' &&
    instruction.value.trim() !== '' &&
    !saving.value
})

// The one live EditorView.updateListener this component owns for its
// lifetime, appended at runtime (StateEffect.appendConfig) and removed on
// unmount (compartment.reconfigure([])) — it never edits the editor's own
// extension set or the annotation decoration plugin.
const draftTrackerCompartment = new Compartment()

function cancel (): void {
  emit('close')
}

async function save (): Promise<void> {
  if (!canSave.value || draftAnchor.value.state !== 'range') {
    return
  }
  const anchor = draftAnchor.value
  saving.value = true
  refusalMessage.value = null
  const result = await window.ipc.invoke('documents:create-annotation', {
    path: props.documentPath,
    from: anchor.from,
    to: anchor.to,
    instruction: instruction.value.trim(),
    expectedAnnotationGeneration: props.annotationGeneration
  }).finally(() => { saving.value = false })

  const failure = result as TextAnnotation | AnnotationFailure
  if ('ok' in failure && failure.ok === false) {
    refusalMessage.value = failure.message
    return
  }
  emit('saved', failure as TextAnnotation)
}

function handleInstructionKeydown (event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    save().catch(err => console.error('Could not save the annotation', err))
  }
}

function handleDialogKeydown (event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    cancel()
  }
}

onMounted(() => {
  props.editorView.dispatch({
    effects: StateEffect.appendConfig.of(
      draftTrackerCompartment.of(EditorView.updateListener.of(update => {
        if (!update.docChanged) {
          return
        }
        draftAnchor.value = mapAnnotationThroughChanges(draftAnchor.value, update.changes).anchor
      }))
    )
  })

  md2html(props.quotedText, {
    zknLinkFormat: 'link|title',
    onCitation: window.getCitationCallback(CITEPROC_MAIN_DB)
  })
    .then(html => { excerptHtml.value = html })
    .catch(err => console.error('Could not render the annotation excerpt', err))

  instructionInput.value?.focus()
})

onBeforeUnmount(() => {
  props.editorView.dispatch({ effects: draftTrackerCompartment.reconfigure([]) })
})
</script>

<style lang="less">
.annotation-create-backdrop {
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

.annotation-create-dialog {
  --dialog-bg: #ffffff;
  --dialog-text: #24272b;
  --dialog-muted: #686d73;
  --dialog-border: #dedcd5;
  --dialog-accent: #5b4fc4;
  --dialog-accent-soft: #efedfb;
  --dialog-danger: #a13c2f;
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(420px, 100%);
  box-sizing: border-box;
  padding: 16px 18px;
  color: var(--dialog-text);
  background: var(--dialog-bg);
  border: 1px solid var(--dialog-border);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, .32);
  font: 13px/1.4 system-ui, sans-serif;

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;

    h2 {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
    }

    [data-close] {
      padding: 2px 8px;
      color: var(--dialog-muted);
      background: transparent;
      border: none;
      border-radius: 6px;
      font-size: 16px;
      line-height: 1;
      cursor: pointer;

      &:hover { background: var(--dialog-accent-soft); }
    }
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .field-label {
    color: var(--dialog-muted);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: .02em;
  }

  .excerpt {
    margin: 0;
    padding: 8px 10px;
    color: var(--dialog-text);
    background: var(--dialog-accent-soft);
    border-left: 3px solid var(--dialog-accent);
    border-radius: 6px;
    font-size: 12.5px;

    &.stale { opacity: .6; }
  }

  .stale-notice {
    margin: 0;
    color: var(--dialog-danger);
    font-size: 11.5px;
  }

  textarea {
    box-sizing: border-box;
    min-height: 88px;
    padding: 8px 10px;
    color: inherit;
    background: var(--dialog-bg);
    border: 1px solid var(--dialog-border);
    border-radius: 8px;
    font: inherit;
    resize: vertical;
    outline: none;

    &:focus { border-color: var(--dialog-accent); }
  }

  .counter {
    align-self: flex-end;
    color: var(--dialog-muted);
    font-size: 11px;
  }

  .refusal {
    margin: 0;
    color: var(--dialog-danger);
    font-size: 12px;
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

      &[data-save] {
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

body.dark .annotation-create-dialog {
  --dialog-bg: #2d3136;
  --dialog-text: #eef0f2;
  --dialog-muted: #aeb4bb;
  --dialog-border: #42474d;
  --dialog-accent: #a79af0;
  --dialog-accent-soft: #322d52;
  --dialog-danger: #e39288;
}
</style>
