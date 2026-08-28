<template>
  <Teleport to="body">
    <div
      class="reference-search-overlay-backdrop"
      @mousedown.self="emit('close')"
    >
      <div
        class="reference-search-overlay"
        role="dialog"
        aria-modal="true"
        :data-search-mode="mode"
        :aria-label="mode === 'citing-locations' ? trans('Workspace citing locations') : trans('Search workspace definitions')"
      >
        <div class="query-row">
          <input
            ref="queryInput"
            v-model="query"
            type="text"
            :placeholder="trans('Search workspace definitions…')"
            :aria-label="trans('Definition search query')"
            @keydown="handleKeydown"
          >
          <button
            class="open-help"
            data-open-help
            type="button"
            :title="trans('Pandoc quick reference')"
            :aria-label="trans('Open the Pandoc quick reference')"
            @click="emit('open-help')"
          >
            ?
          </button>
        </div>
        <template v-if="mode === 'citing-locations'">
          <ul
            v-if="citingLocations.length > 0"
            class="results"
            role="listbox"
          >
            <li
              v-for="(occurrence, index) in citingLocations"
              :key="`${occurrence.documentPath}:${occurrence.range.from}`"
              :class="{ result: true, selected: index === selectedIndex }"
              :data-occurrence-path="occurrence.documentPath"
              :data-occurrence-from="occurrence.range.from"
              role="option"
              :aria-selected="index === selectedIndex"
              @click="emitOccurrenceJump(occurrence)"
            >
              <span class="key">{{ occurrence.clusterRaw }}</span>
              <span class="path">{{ occurrence.documentPath }}</span>
            </li>
          </ul>
          <p
            v-else
            class="no-results"
          >
            {{ trans('No citing locations in the workspace') }}
          </p>
        </template>
        <template v-else>
          <ul
            v-if="matches.length > 0"
            class="results"
            role="listbox"
          >
            <li
              v-for="(definition, index) in matches"
              :key="`${definition.documentPath}:${definition.key}:${definition.range.from}`"
              :class="{ result: true, selected: index === selectedIndex }"
              :data-reference-key="definition.key"
              :data-reference-path="definition.documentPath"
              :data-project-status="projectMarkerOf(definition)?.status"
              role="option"
              :aria-selected="index === selectedIndex"
              @click="emitJump(definition)"
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
            </li>
          </ul>
          <p
            v-else
            class="no-results"
          >
            {{ trans('No matching definitions') }}
          </p>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
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
 *                  Keyed reverse lookup (issue #1 Phase 8): a definition's
 *                  `N references` count badge relays
 *                  openReferenceSearchEffect.of({ key }) up to App.vue,
 *                  which mounts this overlay with initialRequest set. The
 *                  overlay then opens in 'citing-locations' mode (the root
 *                  carries data-search-mode), pre-populates the query with
 *                  the key, and lists that key's workspace OCCURRENCES in
 *                  document order — authored cluster snippets plus citing
 *                  paths — where Enter/click emits the jump intent for the
 *                  occurrence's own range, never the definition's.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import type { ReferenceSearchRequest } from "@common/modules/markdown-editor/plugins/reference-search-effect";
import {
  isCurrentProjectDefinition,
  searchWorkspaceDefinitions,
  type WorkspaceSearchContext,
} from "@common/modules/markdown-editor/util/reference-search";
import {
  computeProjectReferenceStatus,
  projectStatusDisplayName,
} from "@common/pandoc-util/project-reference-status";
import {
  type ProjectRootSpec,
  type ReferenceDefinition,
  type ReferenceOccurrence,
  referenceFamilyDisplayName,
} from "@dts/common/references";
import { computed, onMounted, ref, watch } from "vue";
// The emitted ReferenceJumpIntent contract lives in component-contracts.ts,
// where both vue-tsc and the type-aware linter can resolve it (issue #50).
import type { ReferenceJumpIntent } from "./component-contracts";

const props = withDefaults(
  defineProps<{
    definitions: ReferenceDefinition[];
    /** The merged workspace occurrence list feeding the reverse lookup */
    occurrences?: ReferenceOccurrence[];
    /** The relayed request: null keeps the plain definition search */
    initialRequest?: ReferenceSearchRequest;
    /** Every visible Project root (review A3: current-Project-first ranking) */
    projectRoots?: ProjectRootSpec[];
    /** The document Mod-P was invoked from (review A3) */
    activeDocumentPath?: string;
  }>(),
  {
    occurrences: () => [],
    initialRequest: null,
    projectRoots: () => [],
    activeDocumentPath: undefined,
  },
);

const emit = defineEmits<{
  (e: "jump", intent: ReferenceJumpIntent): void;
  (e: "close"): void;
  (e: "open-help"): void;
}>();

/** The US-16 ranking context, when the host names the invoking document. */
const searchContext = computed<WorkspaceSearchContext | undefined>(() => {
  return props.activeDocumentPath === undefined
    ? undefined
    : { activeDocumentPath: props.activeDocumentPath, projectRoots: props.projectRoots };
});

/** A keyed request opens the reverse lookup; null keeps definition search. */
const mode = computed<"definitions" | "citing-locations">(() => {
  return props.initialRequest === null ? "definitions" : "citing-locations";
});

const query = ref<string>(props.initialRequest?.key ?? "");
const selectedIndex = ref<number>(0);
const queryInput = ref<HTMLInputElement | null>(null);

const matches = computed<ReferenceDefinition[]>(() => {
  return searchWorkspaceDefinitions(props.definitions, query.value, searchContext.value);
});

/**
 * The Project marker of a result row (review A3, US-16): current-Project
 * definitions stay unmarked; every other definition is marked with its
 * computed Project status. Null without a ranking context.
 *
 * @param   {ReferenceDefinition}  definition  The row's definition
 *
 * @return  {{ status: string, display: string }|null}  The marker, if any
 */
function projectMarkerOf(
  definition: ReferenceDefinition,
): { status: string; display: string } | null {
  const context = searchContext.value;
  if (context === undefined || isCurrentProjectDefinition(definition, context)) {
    return null;
  }

  const status = computeProjectReferenceStatus(
    definition.documentPath,
    context.activeDocumentPath,
    context.projectRoots,
  );
  return { status, display: projectStatusDisplayName(status) };
}

/**
 * The workspace citing locations of the queried key, in workspace document
 * order (the merged occurrence list's own order): filtering never reorders.
 */
const citingLocations = computed<ReferenceOccurrence[]>(() => {
  return props.occurrences.filter((occurrence) => occurrence.key === query.value);
});

// A new query re-ranks the rows, so the selection restarts at the top match.
watch(query, () => {
  selectedIndex.value = 0;
});

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
function typeAndTitle(definition: ReferenceDefinition): string {
  const type = referenceFamilyDisplayName(definition.family);
  return definition.title === undefined ? type : `${type} — ${definition.title}`;
}

/**
 * Emits the jump intent for a definition as a plain (non-reactive) object.
 *
 * @param   {ReferenceDefinition}  definition  The chosen definition
 */
function emitJump(definition: ReferenceDefinition): void {
  emit("jump", {
    key: definition.key,
    documentPath: definition.documentPath,
    range: { from: definition.range.from, to: definition.range.to },
  });
}

/**
 * Emits the jump intent for a citing location: the occurrence's own authored
 * range — reverse lookup navigates to usages, never to the definition.
 *
 * @param   {ReferenceOccurrence}  occurrence  The chosen citing location
 */
function emitOccurrenceJump(occurrence: ReferenceOccurrence): void {
  emit("jump", {
    key: occurrence.key,
    documentPath: occurrence.documentPath,
    range: { from: occurrence.range.from, to: occurrence.range.to },
  });
}

/** The row count of whichever result list the current mode presents. */
const activeRowCount = computed<number>(() => {
  return mode.value === "citing-locations" ? citingLocations.value.length : matches.value.length;
});

/**
 * Keyboard interface of the query input: ArrowUp/ArrowDown move the
 * selection, Enter emits the jump intent for the selected row, Escape
 * closes the overlay.
 *
 * @param   {KeyboardEvent}  event  The keydown event
 */
function handleKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (selectedIndex.value < activeRowCount.value - 1) {
      selectedIndex.value += 1;
    }
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    if (selectedIndex.value > 0) {
      selectedIndex.value -= 1;
    }
  } else if (event.key === "Enter") {
    event.preventDefault();
    if (mode.value === "citing-locations") {
      const selected = citingLocations.value[selectedIndex.value];
      if (selected !== undefined) {
        emitOccurrenceJump(selected);
      }
    } else {
      const selected = matches.value[selectedIndex.value];
      if (selected !== undefined) {
        emitJump(selected);
      }
    }
  } else if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
  }
}

onMounted(() => {
  queryInput.value?.focus();
});
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

  .query-row {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    border-bottom: 1px solid var(--search-border);
  }

  input {
    flex: 1 1 auto;
    box-sizing: border-box;
    min-width: 0;
    margin: 0;
    padding: 13px 16px;
    color: inherit;
    background: transparent;
    border: none;
    border-radius: 0;
    font: inherit;
    font-size: 15px;
    outline: none;

    &::placeholder { color: var(--search-muted); }
  }

  button.open-help {
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    width: 26px;
    height: 26px;
    margin-right: 12px;
    padding: 0;
    color: var(--search-muted);
    background: transparent;
    border: 1px solid var(--search-border);
    border-radius: 50%;
    font: 600 13px/1 system-ui, sans-serif;
    cursor: pointer;

    &:hover, &:focus-visible {
      color: var(--search-text);
      border-color: var(--search-accent);
      outline: none;
    }
  }

  .project-marker {
    margin-left: 6px;
    padding: 1px 6px;
    color: var(--search-accent);
    background: var(--search-accent-soft);
    border-radius: 999px;
    font-size: 10px;
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
