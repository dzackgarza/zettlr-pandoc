<template>
  <ComboboxRoot
    ref="combobox"
    class="launcher-view reference-search-view"
    v-bind:open="true"
    v-bind:ignore-filter="true"
    v-bind:reset-search-term-on-blur="false"
    v-bind:reset-search-term-on-select="false"
    model-value=""
    v-bind:data-search-mode="mode"
    v-bind:aria-label="mode === 'citing-locations' ? trans('Workspace citing locations') : trans('Search workspace definitions')"
  >
    <div class="launcher-query-row">
      <span class="launcher-breadcrumb">{{ breadcrumbLabel }}</span>
      <ComboboxInput
        class="launcher-input"
        data-command-launcher-input
        v-bind:auto-focus="true"
        v-bind:model-value="query"
        v-bind:placeholder="trans('Search workspace definitions…')"
        v-bind:aria-label="trans('Definition search query')"
        v-on:update:model-value="query = $event"
        v-on:keydown.backspace="onBackspace"
      ></ComboboxInput>
      <button
        class="reference-search-help"
        data-open-help
        type="button"
        v-bind:title="trans('Pandoc quick reference')"
        v-bind:aria-label="trans('Open the Pandoc quick reference')"
        v-on:click="emit('open-help')"
      >
        ?
      </button>
    </div>
    <ComboboxContent
      class="launcher-list"
      position="inline"
      v-on:escape-key-down="onEscape"
    >
      <ComboboxViewport class="launcher-viewport">
        <template v-if="mode === 'citing-locations'">
          <LauncherRow
            v-for="occurrence in citingLocations"
            v-bind:key="`${occurrence.documentPath}:${occurrence.range.from}`"
            v-bind:value="`${occurrence.documentPath}:${occurrence.range.from}`"
            v-bind:label="occurrence.clusterRaw"
            class="reference-row"
            v-bind:data-occurrence-path="occurrence.documentPath"
            v-bind:data-occurrence-from="occurrence.range.from"
            v-on:run="emitOccurrenceJump(occurrence)"
          >
            <span class="key">{{ occurrence.clusterRaw }}</span>
            <span class="path">{{ occurrence.documentPath }}</span>
          </LauncherRow>
          <ComboboxEmpty class="launcher-empty">
            {{ trans('No citing locations in the workspace') }}
          </ComboboxEmpty>
        </template>
        <template v-else>
          <LauncherRow
            v-for="definition in matches"
            v-bind:key="`${definition.documentPath}:${definition.key}:${definition.range.from}`"
            v-bind:value="`${definition.documentPath}:${definition.key}:${definition.range.from}`"
            v-bind:label="definition.key"
            class="reference-row"
            v-bind:data-reference-key="definition.key"
            v-bind:data-reference-path="definition.documentPath"
            v-bind:data-project-status="projectMarkerOf(definition)?.status"
            v-on:run="emitJump(definition)"
          >
            <span class="type-title">
              {{ typeAndTitle(definition) }}
              <span
                v-if="projectMarkerOf(definition) !== null"
                class="project-marker"
              >{{ projectMarkerOf(definition)?.display }}</span>
            </span>
            <span class="key">{{ definition.key }}</span>
            <span class="path">{{ definition.documentPath }}</span>
          </LauncherRow>
          <ComboboxEmpty class="launcher-empty">
            {{ trans('No matching definitions') }}
          </ComboboxEmpty>
        </template>
      </ComboboxViewport>
    </ComboboxContent>
  </ComboboxRoot>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ReferenceSearchView
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The workspace reference search as one view of the
 *                  command launcher (issue #1 Phase 3b; contract locked by
 *                  test/reference-search-overlay.spec.ts). Receives the full
 *                  workspace definition list, ranks it with
 *                  searchWorkspaceDefinitions() as the user types, and emits
 *                  a 'jump' intent ({ key, documentPath, range }) for the
 *                  selected definition on Enter or click.
 *
 *                  Keyed reverse lookup (issue #1 Phase 8): a definition's
 *                  `N references` count badge relays
 *                  openReferenceSearchEffect.of({ key }) up to App.vue,
 *                  which opens the launcher on this view with initialRequest
 *                  set. The view then opens in 'citing-locations' mode (the
 *                  root carries data-search-mode), pre-populates the query
 *                  with the key, and lists that key's workspace OCCURRENCES
 *                  in document order, where Enter/click emits the jump
 *                  intent for the occurrence's own range, never the
 *                  definition's.
 *
 *                  The rows are launcher rows: reka-ui's combobox owns the
 *                  highlight, Arrow, Home, End and Enter; this view owns
 *                  Backspace on an empty query (one level up) and nothing
 *                  else on the keyboard.
 *
 * END HEADER
 */

// The emitted ReferenceJumpIntent contract lives in component-contracts.ts,
// where both vue-tsc and the type-aware linter can resolve it (issue #50).
import type { ReferenceJumpIntent } from '../component-contracts'
import { ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxRoot, ComboboxViewport } from 'reka-ui'
import { computed, nextTick, ref, watch } from 'vue'
import { trans } from '@common/i18n-renderer'
import {
  searchWorkspaceDefinitions,
  isCurrentProjectDefinition,
  type WorkspaceSearchContext
} from '@common/modules/markdown-editor/util/reference-search'
import {
  computeProjectReferenceStatus,
  projectStatusDisplayName
} from '@common/pandoc-util/project-reference-status'
import type { ReferenceSearchRequest } from '@common/modules/markdown-editor/plugins/reference-search-effect'
import {
  referenceFamilyDisplayName,
  type ProjectRootSpec,
  type ReferenceDefinition,
  type ReferenceOccurrence
} from '@dts/common/references'
import LauncherRow from './LauncherRow.vue'

const props = withDefaults(defineProps<{
  definitions: ReferenceDefinition[]
  /** The merged workspace occurrence list feeding the reverse lookup */
  occurrences?: ReferenceOccurrence[]
  /** The relayed request: null keeps the plain definition search */
  initialRequest?: ReferenceSearchRequest
  /** Every visible Project root (review A3: current-Project-first ranking) */
  projectRoots?: ProjectRootSpec[]
  /** The document the search was invoked from (review A3) */
  activeDocumentPath?: string
}>(), {
  occurrences: () => [],
  initialRequest: null,
  projectRoots: () => [],
  activeDocumentPath: undefined
})

const emit = defineEmits<{
  (e: 'jump', intent: ReferenceJumpIntent): void
  (e: 'close'): void
  (e: 'back'): void
  (e: 'open-help'): void
}>()

interface ComboboxHandle {
  highlightFirstItem: () => void
}

const combobox = ref<ComboboxHandle | null>(null)

/** The US-16 ranking context, when the host names the invoking document. */
const searchContext = computed<WorkspaceSearchContext|undefined>(() => {
  return props.activeDocumentPath === undefined
    ? undefined
    : { activeDocumentPath: props.activeDocumentPath, projectRoots: props.projectRoots }
})

/** A keyed request opens the reverse lookup; null keeps definition search. */
const mode = computed<'definitions'|'citing-locations'>(() => {
  return props.initialRequest === null ? 'definitions' : 'citing-locations'
})

const breadcrumbLabel = computed(() => mode.value === 'citing-locations'
  ? trans('Citing locations')
  : trans('Search references'))

const query = ref<string>(props.initialRequest?.key ?? '')

const matches = computed<ReferenceDefinition[]>(() => {
  return searchWorkspaceDefinitions(props.definitions, query.value, searchContext.value)
})

/**
 * The Project marker of a result row (review A3, US-16): current-Project
 * definitions stay unmarked; every other definition is marked with its
 * computed Project status. Null without a ranking context.
 *
 * @param   {ReferenceDefinition}  definition  The row's definition
 *
 * @return  {{ status: string, display: string }|null}  The marker, if any
 */
function projectMarkerOf (definition: ReferenceDefinition): { status: string, display: string }|null {
  const context = searchContext.value
  if (context === undefined || isCurrentProjectDefinition(definition, context)) {
    return null
  }

  const status = computeProjectReferenceStatus(
    definition.documentPath,
    context.activeDocumentPath,
    context.projectRoots
  )
  return { status, display: projectStatusDisplayName(status) }
}

/**
 * The workspace citing locations of the queried key, in workspace document
 * order (the merged occurrence list's own order): filtering never reorders.
 */
const citingLocations = computed<ReferenceOccurrence[]>(() => {
  return props.occurrences.filter(occurrence => occurrence.key === query.value)
})

// A new query re-ranks the rows, so the selection restarts at the top match.
watch([ matches, citingLocations ], () => {
  // No catch: the combobox is mounted with the rows, so a rejection here is
  // a defect in this view rather than a condition to carry on from, and the
  // window's recoverable-error boundary is where it belongs.
  void nextTick().then(() => { combobox.value?.highlightFirstItem() })
}, { immediate: true })

/**
 * Returns the row headline: `Type — title`, or just the type when nothing
 * was authored as a title. The type comes from the shared family-display
 * authority (referenceFamilyDisplayName), never from a label table local to
 * this view: a family added to the reference registry must reach this row
 * with its display name, not as an undefined lookup.
 *
 * @param   {ReferenceDefinition}  definition  The definition
 *
 * @return  {string}                           The row headline
 */
function typeAndTitle (definition: ReferenceDefinition): string {
  const type = referenceFamilyDisplayName(definition.family)
  return definition.title === undefined ? type : `${type} — ${definition.title}`
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
 * Emits the jump intent for a citing location: the occurrence's own authored
 * range — reverse lookup navigates to usages, never to the definition.
 *
 * @param   {ReferenceOccurrence}  occurrence  The chosen citing location
 */
function emitOccurrenceJump (occurrence: ReferenceOccurrence): void {
  emit('jump', {
    key: occurrence.key,
    documentPath: occurrence.documentPath,
    range: { from: occurrence.range.from, to: occurrence.range.to }
  })
}

function onBackspace (): void {
  if (query.value === '') {
    emit('back')
  }
}

function onEscape (event: Event): void {
  event.preventDefault()
  emit('close')
}
</script>

<style lang="less">
.reference-search-view {
  // `body … button.…` outweighs the platform button rules in generic.css.
  body & button.reference-search-help {
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    width: 26px;
    height: 26px;
    padding: 0;
    color: var(--chrome-text-muted);
    background: transparent;
    border: 1px solid var(--chrome-border);
    border-radius: 50%;
    font: 600 var(--chrome-font-size)/1 system-ui, sans-serif;
    cursor: pointer;

    &:hover, &:focus-visible {
      color: var(--chrome-text);
      border-color: var(--chrome-row-accent);
      outline: none;
    }
  }

  // A reference row stacks its type line, key and path.
  .reference-row {
    min-height: 0;
    padding-top: 6px;
    padding-bottom: 6px;

    .chrome-row-label {
      display: grid;
      gap: 1px;
      white-space: normal;
    }
  }

  .project-marker {
    margin-left: 6px;
    padding: 1px 6px;
    color: var(--chrome-row-accent);
    background: var(--chrome-row-active-bg);
    border-radius: 999px;
    font-size: 10px;
  }

  .type-title, .path {
    overflow: hidden;
    color: var(--chrome-text-muted);
    font-size: var(--chrome-section-font-size);
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .key {
    overflow: hidden;
    font: 500 12.5px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
}
</style>
