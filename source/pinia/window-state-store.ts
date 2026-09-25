/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        useWindowState
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This model manages the state for any given main window, i.e.
 *                  values that represent volatile configuration of the window
 *                  UI or UX without affecting other state managers.
 *
 * END HEADER
 */

import { reportError } from '@common/util/error-reporting'
import { defineStore } from 'pinia'
import type { DocumentInfo } from 'source/common/modules/markdown-editor'
import type { ToCEntry } from 'source/common/modules/markdown-editor/plugins/toc-field'
import { ref, shallowRef, type Ref, watch } from 'vue'
import { type WritingTarget } from '@providers/targets'
import type { FileSearchResult } from 'source/app/service-providers/search'
import type { SnippetCatalogue, SnippetFileDiagnostic, UserSnippet } from '@dts/common/snippets'
import type { QuickTexCatalogue } from '@dts/common/quicktex'
import type { PhraseDictionaryEntry } from 'source/common/util/phrase-dictionary'
import { useConfigStore } from './config'
import { mergeSortedByDocumentPath } from '@common/util/merge-sorted-by-document-path'

const ipcRenderer = window.ipc

async function updateSnippets (
  snippets: Ref<UserSnippet[]>,
  diagnostics: Ref<SnippetFileDiagnostic[]>
): Promise<void> {
  const catalogue: SnippetCatalogue = await ipcRenderer.invoke('assets-provider', {
    command: 'list-snippets'
  })
  snippets.value = catalogue.snippets
  diagnostics.value = catalogue.diagnostics
}

async function updateQuickTex (quickTex: Ref<QuickTexCatalogue>): Promise<void> {
  quickTex.value = await ipcRenderer.invoke('assets-provider', { command: 'get-quicktex' })
}

async function updatePhraseCompletions (phrases: Ref<PhraseDictionaryEntry[]>): Promise<void> {
  phrases.value = await ipcRenderer.invoke('assets-provider', {
    command: 'list-phrase-completions'
  })
}

export const useWindowStateStore = defineStore('window-state', () => {
  const configStore = useConfigStore()
  const isFullscreen = ref(false)
  const uncollapsedDirectories = ref<string[]>([
    ...configStore.config.fileManager.expandedDirectories
  ])
  const distractionFreeMode = ref<undefined|string>(undefined)
  const activeDocumentInfo = ref<undefined|DocumentInfo>(undefined)
  // The file-manager/editor path that most recently held the user's working
  // focus. Modal UI such as the command launcher may temporarily take DOM
  // focus without changing what "here" means for desktop actions.
  const desktopFocusPath = ref<string|undefined>(undefined)
  const tableOfContents = ref<ToCEntry[]|undefined>(undefined)
  const snippets = ref<UserSnippet[]>([])
  const snippetDiagnostics = ref<SnippetFileDiagnostic[]>([])
  const quickTex = ref<QuickTexCatalogue>({
    prose: {}, math: {}, excludeChars: ['{', '(', '['], sourceFile: '', diagnostics: []
  })
  const phraseCompletions = ref<PhraseDictionaryEntry[]>([])
  const writingTargets = ref<WritingTarget[]>([])

  // Expanded Explorer rows are view state, but unlike transient search text
  // they are part of how the user arranged the workspace and should survive a
  // relaunch. Persist the exact absolute paths the tree already uses as its
  // identity; stale paths are harmless and naturally disappear from the view.
  watch(uncollapsedDirectories, paths => {
    configStore.setConfigValue('fileManager.expandedDirectories', [ ...paths ])
  }, { deep: true })

  /**
   * The workspace search's results, one entry per file that matched, in the
   * order the provider read them. The Search view fills this and draws from
   * it; the editor reads it to highlight the matches in the document it
   * shows.
   */
  const searchResults = shallowRef<FileSearchResult[]>([])
  let pendingSearchResults: FileSearchResult[] = []
  let searchPublishFrame: number|undefined

  function mergeSearchResults (incoming: FileSearchResult[]): void {
    searchResults.value = mergeSortedByDocumentPath(searchResults.value, incoming)
  }

  function flushSearchResults (): void {
    if (searchPublishFrame !== undefined) {
      cancelAnimationFrame(searchPublishFrame)
      searchPublishFrame = undefined
    }
    const incoming = pendingSearchResults
    pendingSearchResults = []
    mergeSearchResults(incoming)
  }

  function addSearchResult (result: FileSearchResult): void {
    pendingSearchResults.push(result)
    if (searchPublishFrame === undefined) {
      searchPublishFrame = requestAnimationFrame(() => {
        searchPublishFrame = undefined
        const incoming = pendingSearchResults
        pendingSearchResults = []
        mergeSearchResults(incoming)
      })
    }
  }

  function clearSearchResults (): void {
    if (searchPublishFrame !== undefined) {
      cancelAnimationFrame(searchPublishFrame)
      searchPublishFrame = undefined
    }
    pendingSearchResults = []
    searchResults.value = []
  }

  // Snippets
  ipcRenderer.on('assets-provider', (event, what: string) => {
    if (what === 'snippets-updated') {
      updateSnippets(snippets, snippetDiagnostics).catch(e => reportError(e))
    } else if (what === 'quicktex-updated') {
      updateQuickTex(quickTex).catch(e => reportError(e))
    } else if (what === 'phrase-completions-updated') {
      updatePhraseCompletions(phraseCompletions).catch(e => reportError(e))
    }
  })

  updateSnippets(snippets, snippetDiagnostics).catch(e => reportError(e))
  updateQuickTex(quickTex).catch(e => reportError(e))
  updatePhraseCompletions(phraseCompletions).catch(e => reportError(e))

  // Writing targets
  ipcRenderer.on('targets-provider', (event, what: string) => {
    if (what === 'writing-targets-updated') {
      ipcRenderer.invoke('targets-provider', { command: 'get-targets' })
        .then((targets: WritingTarget[]) => { writingTargets.value = targets })
        .catch(e => reportError(e))
    }
  })

  ipcRenderer.invoke('targets-provider', { command: 'get-targets' })
    .then((targets: WritingTarget[]) => { writingTargets.value = targets })
    .catch(e => reportError(e))
  
  ipcRenderer.on('window-controls', (event, { command, payload }) => {
    if (command === 'fullscreen' && typeof payload === 'boolean') {
      isFullscreen.value = payload
    }
  })

  return {
    uncollapsedDirectories,
    distractionFreeMode,
    activeDocumentInfo,
    desktopFocusPath,
    tableOfContents,
    searchResults,
    addSearchResult,
    flushSearchResults,
    clearSearchResults,
    snippets,
    snippetDiagnostics,
    quickTex,
    phraseCompletions,
    writingTargets,
    isFullscreen
  }
})
