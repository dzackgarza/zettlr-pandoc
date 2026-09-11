<template>
  <div id="search-view">
    <div class="search-view-actions">
      <button
        type="button"
        class="search-icon-button"
        data-search-action="refresh"
        v-bind:title="trans('Refresh')"
        v-bind:aria-label="trans('Refresh')"
        v-on:click="runSearch()"
      >
        <cds-icon
          shape="refresh"
          role="presentation"
        ></cds-icon>
      </button>
      <button
        type="button"
        class="search-icon-button"
        data-search-action="clear"
        v-bind:title="trans('Clear search results')"
        v-bind:aria-label="trans('Clear search results')"
        v-on:click="clearSearch()"
      >
        <cds-icon
          shape="eraser"
          role="presentation"
        ></cds-icon>
      </button>
      <button
        type="button"
        class="search-icon-button"
        data-search-action="collapse-all"
        v-bind:title="trans('Collapse all')"
        v-bind:aria-label="trans('Collapse all')"
        v-on:click="collapseAll()"
      >
        <cds-icon
          shape="minus"
          role="presentation"
        ></cds-icon>
      </button>
      <button
        v-if="undoAvailable"
        type="button"
        class="search-icon-button"
        data-search-action="undo-replace"
        v-bind:title="trans('Undo replace')"
        v-bind:aria-label="trans('Undo replace')"
        v-on:click="undoReplace()"
      >
        <cds-icon
          shape="undo"
          role="presentation"
        ></cds-icon>
      </button>
    </div>

    <div class="search-widget">
      <button
        type="button"
        class="toggle-replace-button"
        data-search-action="toggle-replace"
        v-bind:aria-expanded="replaceShown"
        v-bind:title="trans('Toggle Replace')"
        v-bind:aria-label="trans('Toggle Replace')"
        v-on:click="replaceShown = !replaceShown"
      >
        <cds-icon
          shape="angle"
          v-bind:direction="replaceShown ? 'down' : 'right'"
          role="presentation"
        ></cds-icon>
      </button>
      <div class="search-widget-fields">
        <div class="search-field">
          <input
            ref="queryInput"
            v-model="query.text"
            name="search-input"
            type="text"
            v-bind:placeholder="trans('Search')"
            v-bind:aria-label="trans('Search')"
            v-on:keydown.enter.prevent="runSearch()"
          >
          <button
            v-for="option of MATCH_OPTIONS"
            v-bind:key="option.id"
            type="button"
            class="search-field-toggle"
            v-bind:data-search-toggle="option.id"
            v-bind:aria-pressed="query[option.field]"
            v-bind:title="trans(option.label)"
            v-bind:aria-label="trans(option.label)"
            v-on:click="query[option.field] = !query[option.field]"
          >{{ option.glyph }}</button>
        </div>
        <div
          v-if="replaceShown"
          class="search-field replace-field"
        >
          <input
            v-model="replacement"
            name="replace-input"
            type="text"
            v-bind:placeholder="trans('Replace')"
            v-bind:aria-label="trans('Replace')"
            v-on:keydown.enter.prevent="askToReplaceAll()"
          >
          <button
            type="button"
            class="search-field-toggle"
            data-search-toggle="preserve-case"
            v-bind:aria-pressed="preserveCase"
            v-bind:title="trans('Preserve Case')"
            v-bind:aria-label="trans('Preserve Case')"
            v-on:click="preserveCase = !preserveCase"
          >AB</button>
          <button
            type="button"
            class="search-icon-button"
            data-search-action="replace-all"
            v-bind:disabled="replaceableFiles.length === 0"
            v-bind:title="trans('Replace All')"
            v-bind:aria-label="trans('Replace All')"
            v-on:click="askToReplaceAll()"
          >
            <cds-icon
              shape="switch"
              role="presentation"
            ></cds-icon>
          </button>
        </div>
      </div>
    </div>

    <button
      type="button"
      class="search-details-toggle"
      data-search-action="toggle-details"
      v-bind:aria-expanded="detailsShown"
      v-bind:title="trans('Toggle Search Details')"
      v-bind:aria-label="trans('Toggle Search Details')"
      v-on:click="detailsShown = !detailsShown"
    >…</button>

    <div
      v-if="detailsShown"
      class="query-details"
    >
      <label for="files-to-include">{{ trans('files to include') }}</label>
      <input
        id="files-to-include"
        v-model="query.include"
        name="files-to-include"
        type="text"
        placeholder="*.md, foundations/**"
      >
      <label for="files-to-exclude">{{ trans('files to exclude') }}</label>
      <input
        id="files-to-exclude"
        v-model="query.exclude"
        name="files-to-exclude"
        type="text"
        placeholder="drafts/**"
      >
    </div>

    <div
      v-if="searching"
      class="search-progress"
    >
      <div
        class="search-progress-bar"
        v-bind:style="{ width: `${Math.round(progress * 100)}%` }"
      ></div>
    </div>

    <p
      v-if="message !== ''"
      class="search-message"
      v-bind:class="{ 'search-message-error': searchError !== undefined }"
    >{{ message }}</p>

    <div class="search-results">
      <div
        v-for="file of visibleFiles"
        v-bind:key="file.documentPath"
        class="file-match-group"
        v-bind:data-path="file.documentPath"
      >
        <div
          class="file-match"
          v-on:click="toggleCollapsed(file.documentPath)"
        >
          <cds-icon
            class="file-match-chevron"
            shape="angle"
            v-bind:direction="collapsed.has(file.documentPath) ? 'right' : 'down'"
            role="presentation"
          ></cds-icon>
          <span class="file-match-name">{{ fileName(file.documentPath) }}</span>
          <span class="file-match-path">{{ fileDirectory(file.documentPath) }}</span>
          <span class="row-actions">
            <button
              v-if="replaceShown && file.replaceable"
              type="button"
              class="search-icon-button"
              data-search-action="replace-file"
              v-bind:title="trans('Replace All')"
              v-bind:aria-label="trans('Replace All')"
              v-on:click.stop="replaceFile(file)"
            >
              <cds-icon
                shape="switch"
                role="presentation"
              ></cds-icon>
            </button>
            <button
              type="button"
              class="search-icon-button"
              data-search-action="dismiss-file"
              v-bind:title="trans('Dismiss')"
              v-bind:aria-label="trans('Dismiss')"
              v-on:click.stop="dismissFile(file.documentPath)"
            >
              <cds-icon
                shape="times"
                role="presentation"
              ></cds-icon>
            </button>
          </span>
          <span class="file-match-count">{{ file.matches.length }}</span>
        </div>
        <div
          v-for="match of (collapsed.has(file.documentPath) ? [] : file.matches)"
          v-bind:key="`${file.documentPath}:${match.range.from}`"
          class="line-match"
          v-bind:data-line="match.line"
          v-on:click="emit('jtl', file.documentPath, match.line, false)"
        >
          <span class="line-match-number">{{ match.line }}</span>
          <span class="line-match-preview">
            <span class="match-before">{{ match.preview.before }}</span>
            <span
              class="match-inside"
              v-bind:class="{ replaced: showsReplacement }"
            >{{ match.preview.inside }}</span>
            <span
              v-if="showsReplacement"
              class="match-replace"
            >{{ replacementFor(match) }}</span>
            <span class="match-after">{{ match.preview.after }}</span>
          </span>
          <span class="row-actions">
            <button
              v-if="replaceShown && file.replaceable"
              type="button"
              class="search-icon-button"
              data-search-action="replace-match"
              v-bind:title="trans('Replace')"
              v-bind:aria-label="trans('Replace')"
              v-on:click.stop="replaceMatch(file, match)"
            >
              <cds-icon
                shape="switch"
                role="presentation"
              ></cds-icon>
            </button>
            <button
              type="button"
              class="search-icon-button"
              data-search-action="dismiss-match"
              v-bind:title="trans('Dismiss')"
              v-bind:aria-label="trans('Dismiss')"
              v-on:click.stop="dismissMatch(file.documentPath, match)"
            >
              <cds-icon
                shape="times"
                role="presentation"
              ></cds-icon>
            </button>
          </span>
        </div>
      </div>
    </div>

    <AlertDialogRoot v-model:open="confirmingReplaceAll">
      <AlertDialogPortal>
        <AlertDialogOverlay class="search-dialog-backdrop"></AlertDialogOverlay>
        <AlertDialogContent class="search-dialog">
          <AlertDialogTitle class="search-dialog-title">{{ trans('Replace All') }}</AlertDialogTitle>
          <AlertDialogDescription
            class="search-dialog-body"
            data-search-confirm-message
          >{{ replaceAllQuestion }}</AlertDialogDescription>
          <div class="search-dialog-actions">
            <AlertDialogCancel class="search-button">{{ trans('Cancel') }}</AlertDialogCancel>
            <AlertDialogAction
              class="search-button search-button-primary"
              data-search-confirm="replace-all"
              v-on:click="replaceAll()"
            >{{ trans('Replace') }}</AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialogPortal>
    </AlertDialogRoot>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        SearchView
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The workspace search, on VS Code's search view (M11,
 *                  D11). A widget holds the query with its three matching
 *                  options, a replace field behind a chevron, and the globs
 *                  that scope it behind a details toggle; the search runs as
 *                  the query is typed. Results are a file row per file over
 *                  one row per match, each reading as one line — what
 *                  precedes the match, the match, and the rest of that line
 *                  — with the replacement shown beside a struck-through
 *                  match while a replacement is typed. A row carries Replace
 *                  and Dismiss; the widget carries Replace All, which asks
 *                  first; the view's own actions refresh, clear, collapse
 *                  and undo the last replace.
 *
 *                  The provider owns matching and replacing. This decides
 *                  what to ask for and how to draw what comes back, and
 *                  holds one piece of state of its own: which rows the
 *                  owner dismissed, which are then left out of a replace.
 *
 * END HEADER
 */

import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { trans } from '@common/i18n-renderer'
import { useWindowStateStore } from 'source/pinia'
import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle
} from 'reka-ui'
import { pathBasename, pathDirname } from '@common/util/renderer-path-polyfill'
import { compileQuery, expandReplacement } from 'source/app/service-providers/search/util/search-query'
import type {
  FileSearchResult,
  ReplaceTarget,
  SearchFailure,
  SearchMatch,
  SearchProviderBroadcast,
  SearchProviderIPCAPI,
  SearchQuery
} from 'source/app/service-providers/search'

const ipcRenderer = window.ipc

/** How long the query rests before the search runs, as VS Code debounces it. */
const SEARCH_DEBOUNCE_MS = 200

const MATCH_OPTIONS = [
  { id: 'match-case', field: 'matchCase', glyph: 'Aa', label: 'Match Case' },
  { id: 'whole-word', field: 'wholeWord', glyph: 'ab', label: 'Match Whole Word' },
  { id: 'regex', field: 'regex', glyph: '.*', label: 'Use Regular Expression' }
] as const satisfies ReadonlyArray<{ id: string, field: 'matchCase'|'wholeWord'|'regex', glyph: string, label: string }>

const emit = defineEmits<(e: 'jtl', filePath: string, lineNumber: number, openInNewTab: boolean) => void>()

const windowStateStore = useWindowStateStore()

const query = reactive<SearchQuery>({ text: '', matchCase: false, wholeWord: false, regex: false, include: '', exclude: '' })
const replacement = ref('')
const preserveCase = ref(false)
const replaceShown = ref(false)
const detailsShown = ref(false)
const queryInput = ref<HTMLInputElement|null>(null)

const searching = ref(false)
const progress = ref(0)
const searchError = ref<string|undefined>(undefined)
const undoAvailable = ref(false)
/** Whether a search has run at all: an untouched view says nothing. */
const searched = ref(false)

/** The rows the owner dismissed: a file path, or a path and a match offset. */
const dismissedFiles = reactive(new Set<string>())
const dismissedMatches = reactive(new Set<string>())
const collapsed = reactive(new Set<string>())

const matchKey = (documentPath: string, match: SearchMatch): string => `${documentPath}:${match.range.from}`

/** What the results hold after the dismissals are taken out. */
const visibleFiles = computed<FileSearchResult[]>(() => {
  return windowStateStore.searchResults
    .filter(file => !dismissedFiles.has(file.documentPath))
    .map(file => ({ ...file, matches: file.matches.filter(match => !dismissedMatches.has(matchKey(file.documentPath, match))) }))
    .filter(file => file.matches.length > 0)
})

const matchCount = computed(() => visibleFiles.value.reduce((sum, file) => sum + file.matches.length, 0))
const replaceableFiles = computed(() => visibleFiles.value.filter(file => file.replaceable))
const showsReplacement = computed(() => replaceShown.value && replacement.value !== '')

const message = computed<string>(() => {
  if (searchError.value !== undefined) {
    return searchError.value
  }
  if (searching.value || !searched.value || query.text.trim() === '') {
    return ''
  }
  if (matchCount.value === 0) {
    return trans('No results found.')
  }
  return resultsPhrase(matchCount.value, visibleFiles.value.length)
})

const replaceAllQuestion = computed(() => {
  const matches = replaceableFiles.value.reduce((sum, file) => sum + file.matches.length, 0)
  const files = replaceableFiles.value.length
  return replacement.value === ''
    ? trans('Replace %s with nothing?', occurrencesPhrase(matches, files))
    : trans('Replace %s with "%s"?', occurrencesPhrase(matches, files), replacement.value)
})

/** "3 results in 2 files", down to "1 result in 1 file". */
function resultsPhrase (matches: number, files: number): string {
  if (matches === 1 && files === 1) {
    return trans('1 result in 1 file')
  }
  return files === 1
    ? trans('%s results in 1 file', String(matches))
    : trans('%s results in %s files', String(matches), String(files))
}

/** The same count, as the confirmation asks it. */
function occurrencesPhrase (matches: number, files: number): string {
  if (matches === 1 && files === 1) {
    return trans('1 occurrence across 1 file')
  }
  return files === 1
    ? trans('%s occurrences across 1 file', String(matches))
    : trans('%s occurrences across %s files', String(matches), String(files))
}

function fileName (documentPath: string): string {
  return pathBasename(documentPath)
}

function fileDirectory (documentPath: string): string {
  return pathBasename(pathDirname(documentPath))
}

/**
 * What this match would become. The provider expands the same way when it
 * applies the replace, so a query with capture groups or a preserved case
 * previews what it will actually do rather than the text as typed.
 */
function replacementFor (match: SearchMatch): string {
  const compiled = compileQuery({ ...query })
  if (compiled.status !== 'ready') {
    return replacement.value
  }
  return expandReplacement(match.preview.inside, compiled.pattern, replacement.value, preserveCase.value)
}

function toggleCollapsed (documentPath: string): void {
  if (collapsed.has(documentPath)) {
    collapsed.delete(documentPath)
  } else {
    collapsed.add(documentPath)
  }
}

function collapseAll (): void {
  for (const file of visibleFiles.value) {
    collapsed.add(file.documentPath)
  }
}

function dismissFile (documentPath: string): void {
  dismissedFiles.add(documentPath)
}

function dismissMatch (documentPath: string, match: SearchMatch): void {
  dismissedMatches.add(matchKey(documentPath, match))
}

let debounce: ReturnType<typeof setTimeout>|undefined

/** Runs the query as it stands, dropping what the last one found. */
function runSearch (): void {
  // A search from Enter or an action is this gesture's search: the one the
  // typing was about to start is not also wanted.
  clearTimeout(debounce)
  windowStateStore.searchResults = []
  dismissedFiles.clear()
  dismissedMatches.clear()
  collapsed.clear()
  searchError.value = undefined
  progress.value = 0

  if (query.text.trim() === '') {
    searching.value = false
    searched.value = false
    return
  }

  searched.value = true
  searching.value = true
  ipcRenderer.invoke('search-provider', {
    command: 'start-full-text-search',
    payload: { query: { ...query } }
  } satisfies SearchProviderIPCAPI)
    .catch(err => { reportFailure('search', err) })
}

function clearSearch (): void {
  query.text = ''
  runSearch()
}

watch(query, () => {
  clearTimeout(debounce)
  debounce = setTimeout(() => { runSearch() }, SEARCH_DEBOUNCE_MS)
})

onUnmounted(() => {
  clearTimeout(debounce)
  stopListening()
})

// The view opens because someone means to search: the query takes the
// focus as it appears, the way the reference implementation does.
onMounted(() => { focusQueryInput() })

/**
 * The newest search this view has heard from. A query typed one character
 * at a time starts a search per character, and a result from the one before
 * last must not join the list the newest is filling.
 */
let seenGeneration = 0

// The drawer creates this view every time the owner comes back to it, so
// the listener has to go when the view does: a second copy would add every
// result to the list twice.
const stopListening = ipcRenderer.on('search-provider', (event, message: SearchProviderBroadcast) => {
  if (message.generation < seenGeneration) {
    return
  }
  if (message.generation > seenGeneration) {
    seenGeneration = message.generation
    windowStateStore.searchResults = []
  }
  switch (message.type) {
    case 'search-result':
      progress.value = message.progress
      windowStateStore.addSearchResult(message.result)
      return
    case 'search-progress':
      progress.value = message.progress
      return
    case 'search-failed':
      searching.value = false
      progress.value = 1
      searchError.value = failureMessage(message.failure)
      return
    case 'search-end':
      searching.value = false
      progress.value = 1
  }
})

/** What the view reads out in place of a count it cannot honestly give. */
function failureMessage (failure: SearchFailure): string {
  return failure.kind === 'invalid-query'
    ? trans('Not a regular expression: %s', failure.message)
    : trans('%s could not be read; the search stopped.', pathBasename(failure.documentPath))
}

/** One file's replace target, or one match's. */
function targetFor (file: FileSearchResult, matches: SearchMatch[]): ReplaceTarget {
  return {
    documentPath: file.documentPath,
    sourceHash: file.sourceHash,
    // Plain objects: the store's reactive proxies cannot cross the IPC boundary.
    ranges: matches.map(match => ({ from: match.range.from, to: match.range.to }))
  }
}

function runReplace (targets: ReplaceTarget[]): void {
  if (targets.length === 0) {
    return
  }
  searchError.value = undefined
  ipcRenderer.invoke('search-provider', {
    command: 'replace-in-files',
    payload: { targets, replacement: replacement.value, preserveCase: preserveCase.value }
  } satisfies SearchProviderIPCAPI)
    .then(outcome => {
      if (outcome.status === 'conflict') {
        searchError.value = trans('%s changed since the search; nothing was replaced. Search again.', pathBasename(outcome.documentPath))
        return
      }
      undoAvailable.value = true
      runSearch()
    })
    .catch(err => { reportFailure('replace', err) })
}

function askToReplaceAll (): void {
  if (replaceableFiles.value.length > 0) {
    confirmingReplaceAll.value = true
  }
}

const confirmingReplaceAll = ref(false)

function replaceAll (): void {
  runReplace(replaceableFiles.value.map(file => targetFor(file, file.matches)))
}

function replaceFile (file: FileSearchResult): void {
  runReplace([ targetFor(file, file.matches) ])
}

function replaceMatch (file: FileSearchResult, match: SearchMatch): void {
  runReplace([ targetFor(file, [ match ]) ])
}

/** Applies the provider's one-shot inverse of the last replace, then searches again. */
function undoReplace (): void {
  searchError.value = undefined
  ipcRenderer.invoke('search-provider', { command: 'undo-last-replace', payload: undefined } satisfies SearchProviderIPCAPI)
    .then(outcome => {
      if (outcome.status === 'conflict') {
        searchError.value = trans('%s changed since the replace; nothing was undone.', pathBasename(outcome.documentPath))
        return
      }
      undoAvailable.value = false
      runSearch()
    })
    .catch(err => { reportFailure('replace', err) })
}

/**
 * A request that never reached the provider ends the operation here, and
 * this view is where the owner is watching it, so this is where it says so
 * — naming the operation that failed and carrying the provider's own
 * reason, not a generic one.
 */
function reportFailure (operation: 'search'|'replace', err: unknown): void {
  searching.value = false
  const reason = err instanceof Error ? err.message : String(err)
  searchError.value = operation === 'search'
    ? trans('Search failed: %s', reason)
    : trans('Replace failed: %s', reason)
  console.error('[SearchView] The search provider could not be reached', err)
}

/**
 * The launcher and the Search-all-files menu item reveal this view and
 * focus it in the same breath, so the input may not be in the document yet.
 */
function focusQueryInput (): void {
  nextTick()
    .then(() => { queryInput.value?.focus() })
    .catch(err => { console.error('[SearchView] Could not focus the query', err) })
}

/** The launcher's "Search all files" arrives here with its terms. */
function startSearch (overrideQuery?: string): void {
  if (overrideQuery !== undefined) {
    query.text = overrideQuery
  }
  focusQueryInput()
  runSearch()
}

defineExpose({ focusQueryInput, startSearch })
</script>

<style lang="less">
body div#search-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 6px 8px 0 8px;
  font-size: 13px;
  overflow: hidden;

  .search-view-actions {
    display: flex;
    justify-content: flex-end;
    gap: 2px;
    min-height: 22px;
  }

  button.search-icon-button {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    margin: 0;
    padding: 0;
    border: none;
    border-radius: 4px;
    background-color: transparent;
    color: inherit;
    cursor: pointer;
    opacity: 0.75;

    &:hover:not(:disabled) {
      background-color: var(--chrome-row-hover-bg);
      opacity: 1;
    }

    &:disabled { opacity: 0.35; cursor: default; }

    cds-icon { width: 14px; height: 14px; }
  }

  .search-widget {
    display: flex;
    align-items: flex-start;
    gap: 2px;
  }

  button.toggle-replace-button {
    appearance: none;
    flex: 0 0 auto;
    width: 16px;
    align-self: stretch;
    margin: 0;
    padding: 0;
    border: none;
    background-color: transparent;
    color: inherit;
    cursor: pointer;

    cds-icon { width: 12px; height: 12px; }
  }

  .search-widget-fields {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .search-field {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 2px 0 6px;
    border: 1px solid var(--chrome-border);
    border-radius: 4px;
    background-color: var(--chrome-input-bg, var(--chrome-surface));

    &:focus-within { border-color: var(--chrome-row-accent); }

    input {
      flex: 1 1 auto;
      min-width: 0;
      height: 24px;
      margin: 0;
      padding: 0;
      border: none;
      background-color: transparent;
      color: inherit;
      font: inherit;

      &:focus { outline: none; }
    }
  }

  button.search-field-toggle {
    appearance: none;
    flex: 0 0 auto;
    min-width: 20px;
    height: 20px;
    margin: 0;
    padding: 0 3px;
    border: none;
    border-radius: 3px;
    background-color: transparent;
    color: inherit;
    font: inherit;
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
    opacity: 0.7;

    &:hover { background-color: var(--chrome-row-hover-bg); opacity: 1; }

    &[aria-pressed="true"] {
      background-color: var(--chrome-row-accent);
      color: var(--chrome-row-accent-contrast, white);
      opacity: 1;
    }
  }

  button.search-details-toggle {
    appearance: none;
    align-self: flex-end;
    height: 16px;
    margin: 2px 0;
    padding: 0 6px;
    border: none;
    background-color: transparent;
    color: inherit;
    line-height: 1;
    cursor: pointer;
    opacity: 0.7;

    &:hover { opacity: 1; }
  }

  .query-details {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-left: 18px;

    label {
      font-size: 11px;
      opacity: 0.7;
    }

    input {
      height: 24px;
      margin-bottom: 2px;
      padding: 0 6px;
      border: 1px solid var(--chrome-border);
      border-radius: 4px;
      background-color: var(--chrome-input-bg, var(--chrome-surface));
      color: inherit;
      font: inherit;

      &:focus { outline: none; border-color: var(--chrome-row-accent); }
    }
  }

  .search-progress {
    height: 2px;
    margin: 4px 0;
    background-color: var(--chrome-border);
  }

  .search-progress-bar {
    height: 100%;
    background-color: var(--chrome-row-accent);
    transition: width 120ms linear;
  }

  .search-message {
    margin: 6px 0;
    padding-left: 18px;
    opacity: 0.8;

    &.search-message-error {
      color: var(--annotation-danger, rgb(196, 60, 60));
      opacity: 1;
    }
  }

  .search-results {
    flex: 1 1 auto;
    min-height: 0;
    margin: 0 -8px;
    overflow-y: auto;
  }

  .file-match, .line-match {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 8px;
    cursor: pointer;
    white-space: pre;

    &:hover {
      background-color: var(--chrome-row-hover-bg);

      .row-actions { display: inline-flex; }
      .file-match-count { display: none; }
    }
  }

  .file-match-chevron { flex: 0 0 auto; width: 12px; height: 12px; }
  .file-match-name { flex: 0 0 auto; font-weight: 600; }

  .file-match-path {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 11px;
    opacity: 0.6;
  }

  .file-match-count {
    flex: 0 0 auto;
    min-width: 16px;
    padding: 0 4px;
    border-radius: 8px;
    background-color: var(--chrome-border);
    font-size: 11px;
    text-align: center;
  }

  .line-match { padding-left: 26px; }

  .line-match-number {
    flex: 0 0 auto;
    min-width: 18px;
    text-align: right;
    font-size: 11px;
    opacity: 0.5;
  }

  .line-match-preview {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .match-inside {
    background-color: var(--chrome-search-match-bg, rgba(234, 92, 0, 0.33));

    &.replaced { text-decoration: line-through; }
  }

  .match-replace { background-color: var(--chrome-search-replace-bg, rgba(40, 140, 90, 0.33)); }

  .row-actions {
    display: none;
    flex: 0 0 auto;
    gap: 0;
  }

  .search-dialog-backdrop {
    position: fixed;
    inset: 0;
    background-color: rgba(0, 0, 0, 0.35);
  }

  .search-dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 340px;
    max-width: calc(100vw - 32px);
    padding: 16px;
    border: 1px solid var(--chrome-border);
    border-radius: 8px;
    background-color: var(--chrome-surface);
    color: inherit;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.25);
  }

  .search-dialog-title { margin: 0; font-size: 13px; font-weight: 600; }
  .search-dialog-body { margin: 0; opacity: 0.8; }

  .search-dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }

  button.search-button {
    appearance: none;
    margin: 0;
    padding: 5px 10px;
    border: 1px solid var(--chrome-border);
    border-radius: 6px;
    background-color: var(--chrome-surface);
    color: inherit;
    font: inherit;
    font-size: 12px;
    cursor: pointer;

    &.search-button-primary {
      border-color: transparent;
      background-color: var(--chrome-row-accent);
      color: var(--chrome-row-accent-contrast, white);
    }
  }
}
</style>
