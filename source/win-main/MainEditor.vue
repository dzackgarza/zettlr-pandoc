<template>
  <div
    ref="mainEditorWrapper"
    class="main-editor-wrapper"
    role="region"
    v-bind:aria-label="`Markdown Editor: Currently editing file ${pathBasename(props.file.path)}`"
    v-bind:style="{ 'font-size': `${fontSize}px` }"
    v-bind:class="{
      'code-file': !isMarkdown,
      fullscreen: distractionFree
    }"
  >
    <div v-bind:id="`cm-text-${props.leafId}`">
      <!-- This element will be replaced with Codemirror's wrapper element on mount -->
    </div>
  </div>
</template>

<script setup lang="ts">

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Editor
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This displays the main editor for the app. It uses the
 *                  MarkdownEditor class to implement the full CodeMirror editor.
 *
 * END HEADER
 */

import MarkdownEditor, { type EditorViewPersistentState } from '@common/modules/markdown-editor'

import { ref, computed, onMounted, onBeforeUnmount, watch, toRef, onUpdated } from 'vue'
import { type EditorCommands } from './App.vue'
import { hasMarkdownExt } from '@common/util/file-extention-checks'
import { DP_EVENTS, type OpenDocument } from '@dts/common/documents'
import { CITEPROC_MAIN_DB } from '@dts/common/citeproc'
import { type EditorConfigOptions } from '@common/modules/markdown-editor/util/configuration'
import type { CodeFileDescriptor, DirDescriptor, MDFileDescriptor } from '@dts/common/fsal'
import { getBibliographyForDescriptor as getBibliography } from '@common/util/get-bibliography-for-descriptor'
import { EditorSelection } from '@codemirror/state'
import { documentAuthorityIPCAPI } from '@common/modules/markdown-editor/util/ipc-api'
import { useConfigStore, useDocumentTreeStore, useTagsStore, useWindowStateStore, useWorkspaceStore } from 'source/pinia'
import { isAbsolutePath, pathBasename, pathDirname, resolvePath } from '@common/util/renderer-path-polyfill'
import type { DocumentManagerIPCAPI, DocumentsUpdateContext } from 'source/app/service-providers/documents'
import type { CiteprocProviderIPCAPI } from 'source/app/service-providers/citeproc'
import type { ProjectInfo } from 'source/common/modules/markdown-editor/plugins/project-info-field'
import type { FileContentSearchResult } from 'source/app/service-providers/search'
import type { DocumentLocation, ReferenceCompletionEntry, SourceRange } from '@dts/common/references'
import type { WorkspaceReferenceState } from 'source/app/service-providers/references/reference-index'
import { extractReferences } from '@common/pandoc-util/extract-references'
import { resolveWorkspace } from '@common/pandoc-util/resolve-references'
import { trans } from '@common/i18n-renderer'
import showPopupMenu, { type AnyMenuItem } from '@common/modules/window-register/application-menu-helper'
import showToast from '@common/util/show-toast'
import type { ReferenceKeyEditPromptIntent } from '@common/modules/markdown-editor/plugins/reference-key-edit-prompt'
import type { CreateReferenceLabelIntent, CreateReferenceLabelRequest } from '@common/modules/markdown-editor/plugins/create-reference-label'
import type {
  CommitRenameOutcome,
  ReferenceRenamePreview,
  ReferenceRenameRejection
} from '@common/pandoc-util/compute-reference-edits'

const ipcRenderer = window.ipc

// This function overwrites the getBibliographyForDescriptor function to ensure
// the library is always absolute. We have to do it this ridiculously since the
// function is called in both main and renderer processes, and we still have the
// issue that path-browserify is entirely unusable.
function getBibliographyForDescriptor (descriptor: MDFileDescriptor): string {
  const library = getBibliography(descriptor)

  if (library !== CITEPROC_MAIN_DB && !isAbsolutePath(library)) {
    return resolvePath(descriptor.dir, library)
  } else {
    return library
  }
}

const props = defineProps<{
  leafId: string
  windowId: string
  activeFile: OpenDocument|null
  editorCommands: EditorCommands
  distractionFree: boolean
  file: OpenDocument
  persistentStateMap: Map<string, EditorViewPersistentState>
}>()

/**
 * The relayed create-label request App.vue mounts the dialog over: the
 * context-fixed family, the editable slug proposal, and the closure that
 * performs the prepared insertion in the invoking editor once the dialog
 * confirms a key (clipboard write and toast are App.vue's half).
 */
export interface CreateReferenceLabelDialogPrompt {
  family: CreateReferenceLabelRequest['family']
  proposedSlug: string
  applyCreate: (intent: CreateReferenceLabelIntent) => void
}

const emit = defineEmits<{
  (e: 'globalSearch', query: string): void
  (e: 'referenceSearch'): void
  (e: 'createReferenceLabel', prompt: CreateReferenceLabelDialogPrompt): void
}>()

const windowStateStore = useWindowStateStore()
const documentTreeStore = useDocumentTreeStore()
const workspaceStore = useWorkspaceStore()
const configStore = useConfigStore()
const tagStore = useTagsStore()

// UNREFFED STUFF
let currentEditor: MarkdownEditor|null = null

/**
 * The navigation payload of the last ACTIVE_FILE event for this leaf
 * (issue #1 Phase 5): either the DocumentLocation of a restored Back/Forward
 * history entry, or the definition targetRange of a cross-file reference
 * jump. Applied once the editor for that file is loaded (or immediately when
 * it already is), then cleared.
 */
let pendingNavigation: { filePath: string, location?: DocumentLocation, targetRange?: SourceRange }|null = null

/**
 * Applies (and clears) the pending navigation payload when the currently
 * loaded editor shows the file it belongs to.
 */
function applyPendingNavigation (): void {
  if (pendingNavigation === null || currentEditor === null) {
    return
  }

  if (pendingNavigation.filePath !== currentEditor.documentPath) {
    return // The pane moved elsewhere; keep waiting or get superseded.
  }

  const { location, targetRange } = pendingNavigation
  pendingNavigation = null

  if (location !== undefined) {
    currentEditor.restoreDocumentLocation(location)
  } else if (targetRange !== undefined) {
    currentEditor.selectSourceRange(targetRange)
  }
}

// EVENT LISTENERS
ipcRenderer.on('citeproc-database-updated', (_event, _dbPath: string) => {
  const descriptor = activeFileDescriptor.value

  if (descriptor === undefined || descriptor.type !== 'file') {
    return // Nothing to do
  }

  const library = getBibliographyForDescriptor(descriptor)
  updateCitationKeys(library).catch(e => {
    console.error('Could not update citation keys', e)
  })
})

// Combined @-completion label feed (issue #1 Phase 3). Mirrors the
// citation-keys feed above: whenever main broadcasts changed workspace
// references, fetch the snapshot and push the typed 'references' completion
// database. NOTE: the main-process reference provider Electron shell is
// deferred, so a missing handler must fail gracefully at runtime (log only —
// never fabricate fallback data). No headless spec exercises Vue components;
// this wiring is probe-covered later.
ipcRenderer.on('references', _event => {
  updateReferenceEntries().catch(e => {
    console.error('Could not update workspace reference entries', e)
  })
})

ipcRenderer.on('shortcut', (event, command) => {
  if (currentEditor?.hasFocusWithin() !== true) {
    return // None of our business
  }

  if (command === 'save-file') {
    // Main is telling us to save, so tell main to save the current file.
    ipcRenderer.invoke('documents-provider', {
      command: 'save-file',
      payload: { path: props.file.path }
    } as DocumentManagerIPCAPI)
      .then(result => {
        if (result !== true) {
          console.error('Retrieved a falsy result from main, indicating an error with saving the file.')
        }
      })
      .catch(e => console.error(e))
  } else if (command === 'search') {
    currentEditor.toggleSearchPanel()
  } else if (command === 'toggle-typewriter-mode') {
    currentEditor.hasTypewriterMode = !currentEditor.hasTypewriterMode
  } else if (command === 'copy-as-html') {
    currentEditor.copyAsHTML()
  } else if (command === 'paste-as-plain') {
    currentEditor.pasteAsPlainText()
  }
})

ipcRenderer.on('documents-update', (e, payload: { event: DP_EVENTS, context: DocumentsUpdateContext }) => {
  const { event, context } = payload
  if (
    event === DP_EVENTS.ACTIVE_FILE && context.leafId === props.leafId &&
    context.filePath !== undefined &&
    (context.location !== undefined || context.targetRange !== undefined)
  ) {
    // The activation carries a navigation payload (issue #1 Phase 5): a
    // Back/Forward-restored DocumentLocation or a cross-file reference jump
    // landing range. Record it, and apply it right away when the editor for
    // that file is already loaded (otherwise the 'loaded' hook applies it
    // after the remount).
    pendingNavigation = {
      filePath: context.filePath,
      location: context.location,
      targetRange: context.targetRange
    }
    applyPendingNavigation()
  }

  if (event === DP_EVENTS.FILE_REMOTELY_CHANGED && context.filePath === props.file.path) {
    // The currently loaded document has been changed remotely. This event indicates
    // that the document provider has already reloaded the document and we only
    // need to tell the main editor to reload it as well.
    currentEditor?.reload().catch(e => console.error(e))
  } else if (event === DP_EVENTS.FILE_SAVED && context.filePath === props.file.path) {
    // The file has been saved to disk. This means we should probably update the
    // descriptor to know of, e.g., library changes.
    ipcRenderer.invoke('fsal', { command: 'get-descriptor', payload: props.file.path })
      .then((descriptor: MDFileDescriptor|CodeFileDescriptor|undefined) => {
        if (descriptor === undefined) {
          throw new Error(`Could not swap document: Could not retrieve descriptor for path ${props.file.path}!`)
        }

        activeFileDescriptor.value = descriptor
        const library = descriptor.type === 'file' ? getBibliographyForDescriptor(descriptor) : undefined
        if (library !== undefined) {
          updateCitationKeys(library).catch(e => console.error('Could not update citation keys', e))
        }

        // Provide the editor instance with updated metadata
        currentEditor?.setOptions({
          metadata: {
            path: props.file.path,
            id: descriptor.type === 'file' ? descriptor.id : '',
            library: library ?? CITEPROC_MAIN_DB
          }
        })
      })
      .catch(err => console.error(err))
  }
})

ipcRenderer.on('reload-editors', _e => {
  currentEditor?.reload().catch(err => console.error('Failed to reload editor after `reload-editors` event', err))
})

// Update the file database whenever links have been updated
ipcRenderer.on('links', _e => {
  updateFileDatabase().catch(err => console.error('Could not update file database', err))
})

// MOUNTED HOOK
onMounted(() => {
  loadDocument().catch(err => console.error(err))
})

onBeforeUnmount(() => {
  if (currentEditor !== null) {
    props.persistentStateMap.set(props.file.path, currentEditor.persistentState)
    // Clear out the table of contents before unmounting the component.
    windowStateStore.tableOfContents = undefined
    currentEditor.unmount()
  }
})

onUpdated(() => {
  // We hook into the onUpdated lifecycle event since that will fire when the
  // data for this component update, which includes visibility with the v-show
  // directive. In case that the editor component is mounted and non-hidden, we
  // will fire
  if (currentEditor === null) {
    return
  }

  const currentFilePath = currentEditor.documentPath
  if (currentFilePath !== props.activeFile?.path) {
    // File path has changed -> unmount and remount (duplicate code from
    // onMounted and onBeforeUnmount hooks).
    props.persistentStateMap.set(currentFilePath, currentEditor.persistentState)
    currentEditor.unmount()
    loadDocument().catch(err => console.error(err))
  }

  if (!currentEditor.hasFocus()) {
    currentEditor.focus()
  }
})

// DATA SETUP
const mainEditorWrapper = ref<HTMLDivElement|null>(null)

// COMPUTED PROPERTIES
const useH1 = computed<boolean>(() => configStore.config.fileNameDisplay.includes('heading'))
const useTitle = computed<boolean>(() => configStore.config.fileNameDisplay.includes('title'))
const fontSize = computed<number>(() => configStore.config.editor.fontSize)
const globalSearchResults = computed(() => windowStateStore.searchResults)
const snippets = computed(() => windowStateStore.snippets)
const tags = computed(() => tagStore.tags)
const isMarkdown = computed(() => hasMarkdownExt(props.file.path))

const activeFileDescriptor = ref<undefined|MDFileDescriptor|CodeFileDescriptor>(undefined)

const editorConfiguration = computed<EditorConfigOptions>(() => {
  // We update everything, because not so many values are actually updated
  // right after setting the new configurations. Plus, the user won't update
  // everything all the time, but rather do one initial configuration, so
  // even if we incur a performance penalty, it won't be noticed that much.
  const { editor, display, zkn, darkMode, darkModeEditor } = configStore.config
  return {
    indentUnit: editor.indentUnit,
    indentWithTabs: editor.indentWithTabs,
    alwaysIndentLineOnTab: editor.alwaysIndentLineOnTab,
    autoCloseBrackets: editor.autoCloseBrackets,
    autocorrect: {
      active: editor.autoCorrect.active,
      matchWholeWords: editor.autoCorrect.matchWholeWords,
      magicQuotes: {
        primary: editor.autoCorrect.magicQuotes.primary,
        secondary: editor.autoCorrect.magicQuotes.secondary
      },
      replacements: editor.autoCorrect.replacements
    },
    autocompleteSuggestEmojis: editor.autocompleteSuggestEmojis,
    snippetAutocompleteTriggerCharacter: editor.snippetAutocompleteTriggerCharacter,
    imagePreviewWidth: display.imageWidth,
    imagePreviewHeight: display.imageHeight,
    boldFormatting: editor.boldFormatting,
    italicFormatting: editor.italicFormatting,
    highlightFormatting: editor.highlightFormatting,
    muteLines: configStore.config.muteLines,
    citeStyle: editor.citeStyle,
    readabilityAlgorithm: editor.readabilityAlgorithm,
    idRE: zkn.idRE,
    idGen: zkn.idGen,
    previewModeShowSyntaxWhenCursorIsAdjacent: display.previewModeShowSyntaxWhenCursorIsAdjacent,
    renderCitations: display.renderCitations,
    renderingMode: display.renderingMode,
    renderIframes: display.renderIframes,
    renderImages: display.renderImages,
    renderLinks: display.renderLinks,
    renderMath: display.renderMath,
    renderTasks: display.renderTasks,
    renderHeadings: display.renderHTags,
    renderTables: editor.enableTableHelper,
    renderEmphasis: display.renderEmphasis,
    renderPandoc: display.renderPandoc,
    renderHorizontalRules: display.renderHorizontalRules,
    zknLinkFormat: zkn.linkFormat,
    zknAddFileTitle: zkn.linkAddFileTitle,
    linkWithIDIfPossible: zkn.linkWithIDIfPossible,
    inputMode: editor.inputMode,
    lintMarkdown: editor.lint.markdown,
    // The editor only needs to know if it should use languageTool
    lintLanguageTool: editor.lint.languageTool.active,
    distractionFree: props.distractionFree.valueOf(),
    showStatusbar: editor.showStatusbar,
    showFormattingToolbar: editor.showFormattingToolbar,
    darkMode,
    darkModeEditor,
    theme: display.theme,
    highlightWhitespace: editor.showWhitespace,
    showMarkdownLineNumbers: editor.showMarkdownLineNumbers,
    countChars: editor.countChars
  } satisfies EditorConfigOptions
})

// BEGIN: PROJECT INFO
function updateProjectInfo (): ProjectInfo|null {
  // If this file is part of a project, the project must be defined in any
  // containing folder -> traverse up the file tree until we have found one.
  let dir = workspaceStore.descriptorMap.get(pathDirname(props.file.path)) as DirDescriptor|undefined

  while (dir !== undefined && dir.settings.project === null) {
    dir = workspaceStore.descriptorMap.get(dir.dir) as DirDescriptor|undefined
  }

  if (dir === undefined || dir.settings.project === null) {
    return null // No project found in the tree
  }

  // Check if this file is part of the project.
  const absPaths = dir.settings.project.files.map(p => resolvePath(dir.path, p))
  if (!absPaths.includes(props.file.path)) {
    return null
  }

  const extractedMetadata = absPaths
    .map(p => {
      return workspaceStore.descriptorMap.get(p)
    })
    .filter (d => d !== undefined && d.type === 'file')
    .map(d => {
      return {
        wordCount: d.wordCount,
        charCount: d.charCount,
        path: d.path,
        displayName: d.yamlTitle ?? d.firstHeading ?? d.name
      }
    })

  // It is! So now we can return the proper project info.
  return {
    name: dir.settings.project.title,
    files: extractedMetadata
      .map(p => ({ path: p.path, displayName: p.displayName })),
    wordCount: extractedMetadata
      .map(p => p.wordCount)
      .reduce((p, c) => p + c, 0),
    charCount: extractedMetadata
      .map(p => p.charCount)
      .reduce((p, c) => p + c, 0)
  }
}

// Update the project info as soon as anything in the workspaces has changed.
workspaceStore.$subscribe(() => {
  if (currentEditor !== null) {
    currentEditor.projectInfo = updateProjectInfo()
  }
})
// END: PROJECT INFO

// External commands/"event" system
watch(toRef(props.editorCommands, 'jumpToLine'), () => {
  const { filePath, lineNumber } = props.editorCommands.data
  // Execute a jtl-command if the current displayed file is the correct one
  if (filePath === props.file.path && typeof lineNumber === 'number') {
    jtl(lineNumber)
  }
})

watch(toRef(props.editorCommands, 'moveSection'), () => {
  if (props.activeFile?.path !== props.file.path || documentTreeStore.lastLeafId !== props.leafId) {
    return
  }

  const { from, to } = props.editorCommands.data
  if (typeof from === 'number' && typeof to === 'number') {
    currentEditor?.moveSection(from, to)
  }
})

watch(toRef(props, 'distractionFree'), () => {
  if (currentEditor !== null && props.activeFile?.path === props.file.path && documentTreeStore.lastLeafId === props.leafId) {
    currentEditor.distractionFree = props.distractionFree
  }
})

watch(toRef(props.editorCommands, 'executeCommand'), () => {
  if (props.activeFile?.path !== props.file.path || currentEditor === null) {
    return
  }

  if (documentTreeStore.lastLeafId !== props.leafId) {
    // This editor, even though it may be focused, was not the last focused
    // See https://github.com/Zettlr/Zettlr/issues/4361
    return
  }

  const command: string = props.editorCommands.data
  currentEditor.runCommand(command)
  currentEditor.focus()
})

watch(toRef(props.editorCommands, 'replaceSelection'), () => {
  if (props.activeFile?.path !== props.file.path) {
    return
  }

  if (documentTreeStore.lastLeafId !== props.leafId) {
    // This editor, even though it may be focused, was not the last focused
    // See https://github.com/Zettlr/Zettlr/issues/4361
    return
  }

  const textToInsert: string = props.editorCommands.data
  currentEditor?.replaceSelection(textToInsert)
})

watch(toRef(props.editorCommands, 'insertPandoc'), () => {
  if (props.activeFile?.path !== props.file.path || currentEditor === null) {
    return
  }

  if (documentTreeStore.lastLeafId !== props.leafId) {
    // This editor, even though it may be focused, was not the last focused
    // See https://github.com/Zettlr/Zettlr/issues/4361
    return
  }

  const { type, attributes } = props.editorCommands.data
  if ((type === 'div' || type === 'span') && typeof attributes === 'string') {
    currentEditor?.insertPandocDivOrSpan(type as 'div'|'span', attributes)
    currentEditor?.focus()
  }
})

const fsalFiles = computed<MDFileDescriptor[]>(() => {
  return [...workspaceStore.descriptorMap.values()].filter(d => d.type === 'file')
})

// WATCHERS
watch(useH1, () => { updateFileDatabase().catch(err => console.error('Could not update file database', err)) })
watch(useTitle, () => { updateFileDatabase().catch(err => console.error('Could not update file database', err)) })
watch(fsalFiles, () => { updateFileDatabase().catch(err => console.error('Could not update file database', err)) })

watch(editorConfiguration, (newValue) => {
  currentEditor?.setOptions(newValue)
})

watch(globalSearchResults, () => {
  // TODO: I don't like that we need a timeout here.
  setTimeout(maybeHighlightSearchResults, 200)
})

watch(snippets, (newValue) => {
  currentEditor?.setCompletionDatabase('snippets', newValue)
})

watch(tags, (newValue) => {
  currentEditor?.setCompletionDatabase('tags', newValue)
})

// METHODS
/**
 * Returns a MarkdownEditor for the provided path.
 *
 * @param   {string}          doc  The document to load
 *
 * @return  {MarkdownEditor}       The requested editor
 */
async function getEditorFor (doc: string): Promise<MarkdownEditor> {
  const persistentState = props.persistentStateMap.get(doc)
  const editor = new MarkdownEditor(props.leafId, props.windowId, doc, documentAuthorityIPCAPI, undefined, persistentState)

  // Update the document info on corresponding events
  editor.on('loaded', () => {
    if (currentEditor === editor) {
      windowStateStore.activeDocumentInfo = currentEditor.documentInfo
      windowStateStore.tableOfContents = currentEditor.tableOfContents
      // A pane navigation may have arrived before this editor finished
      // loading its document (issue #1 Phase 5); restore it now.
      applyPendingNavigation()
    }
  })

  editor.on('change', () => {
    if (currentEditor === editor) {
      windowStateStore.tableOfContents = currentEditor.tableOfContents
    }
  })

  editor.on('docUpdate', () => {
    if (currentEditor === editor) {
      windowStateStore.activeDocumentInfo = currentEditor.documentInfo
    }
  })

  editor.on('focus', () => {
    ipcRenderer.invoke('documents-provider', {
      command: 'focus-leaf',
      payload: {
        leafId: props.leafId,
        windowId: props.windowId
      }
    } as DocumentManagerIPCAPI).catch(err => console.error(err))

    // NOTE: The lastLeafId will be changed in the documentTreeStore in response
    // to an event from main (DP_EVENTS.ACTIVE_FILE) which will be emitted as a
    // result of our focus-leaf event above.
    if (currentEditor === editor) {
      windowStateStore.tableOfContents = currentEditor.tableOfContents
    }
  })

  editor.on('zettelkasten-link', (linkContents: string) => {
    ipcRenderer.invoke('application', {
      command: 'force-open',
      payload: {
        linkContents,
        newTab: undefined, // let open-file command decide based on preferences
        leafId: props.leafId,
        windowId: props.windowId
      }
    })
      .catch(err => console.error(err))

    if (configStore.config.zkn.autoSearch) {
      emit('globalSearch', linkContents)
    }
  })

  editor.on('zettelkasten-tag', (tag: string) => {
    emit('globalSearch', tag)
  })

  // Mod-P inside the editor requested the workspace reference search overlay
  // (issue #1 Phase 3b); relay it up the component tree to App.vue.
  editor.on('reference-search', () => {
    emit('referenceSearch')
  })

  // The context menu (or command registry) requested the create-label
  // dialog for a resolved target (issue #1 Phase 6): relay the typed
  // request up to App.vue's dialog mount together with the closure that
  // performs the prepared insertion once the dialog confirms a key.
  editor.on('create-reference-label', (request: CreateReferenceLabelRequest) => {
    emit('createReferenceLabel', {
      family: request.family,
      proposedSlug: request.proposedSlug,
      applyCreate: (intent: CreateReferenceLabelIntent) => {
        const view = currentEditor?.instance
        if (view === undefined) {
          return
        }
        const { from, to, prefix, suffix } = request.insertion
        view.dispatch({ changes: { from, to, insert: prefix + intent.insertText + suffix } })
      }
    })
  })

  // The selection left a directly edited definition-id token (issue #1
  // Phase 6): offer the workspace rename. Declining does nothing further —
  // the local edit stays and the reference diagnostics flag the stale uses.
  editor.on('reference-key-edit-prompt', (intent: ReferenceKeyEditPromptIntent) => {
    promptWorkspaceRename(intent)
  })

  // Supply the configuration object once initially
  editor.setOptions(editorConfiguration.value)
  return editor
}

/**
 * Loads the document for this editor instance.
 */
async function loadDocument (): Promise<void> {
  const newEditor = await getEditorFor(props.file.path)

  mainEditorWrapper.value?.appendChild(newEditor.dom)
  currentEditor = newEditor

  currentEditor.setCompletionDatabase('tags', tags.value)
  currentEditor.setCompletionDatabase('snippets', snippets.value)

  maybeHighlightSearchResults()

  const descriptor: MDFileDescriptor|CodeFileDescriptor|undefined = await ipcRenderer.invoke('fsal', { command: 'get-descriptor', payload: props.file.path })
  if (descriptor === undefined) {
    throw new Error(`Could not swap document: Could not retrieve descriptor for path ${props.file.path}!`)
  }

  activeFileDescriptor.value = descriptor

  const library = descriptor.type === 'file' ? getBibliographyForDescriptor(descriptor) : undefined
  if (library !== undefined) {
    updateCitationKeys(library).catch(e => console.error('Could not update citation keys', e))
  }

  updateFileDatabase().catch(err => console.error('Could not update file database', err))

  // Provide the editor instance with metadata for the new file
  currentEditor.setOptions({
    metadata: {
      path: props.file.path,
      id: descriptor.type === 'file' ? descriptor.id : '',
      library: library ?? CITEPROC_MAIN_DB
    }
  })
  currentEditor.projectInfo = updateProjectInfo()
}

function jtl (lineNumber: number): void {
  currentEditor?.jtl(lineNumber)
}

async function updateCitationKeys (library: string): Promise<void> {
  const items: Array<{ citekey: string, displayText: string }> = (await ipcRenderer.invoke('citeproc-provider', {
    command: 'get-items',
    payload: { database: library }
  } as CiteprocProviderIPCAPI))
    .map((item: CSLItem) => {
      // Get a rudimentary author list. Precedence are authors, then editors.
      // Fallback: Container title.
      let authors = ''
      const authorSrc = item.author !== undefined && Array.isArray(item.author)
        ? item.author
        : item.editor !== undefined && Array.isArray(item.editor) ? item.editor : []

      if (authorSrc.length > 0) {
        authors = authorSrc.map(author => {
          if (author.family !== undefined) {
            return author.family
          } else if (author.literal !== undefined) {
            return author.literal
          } else {
            return undefined
          }
        }).filter(elem => elem !== undefined).join(', ')
      } else if (item['container-title'] !== undefined && typeof item['container-title'] === 'string') {
        authors = item['container-title']
      }

      let title = ''
      if (item.title !== undefined && typeof item.title === 'string') {
        title = item.title
      } else if (item['container-title'] !== undefined && typeof item['container-title'] === 'string') {
        title = item['container-title']
      }

      let date = ''
      if (item.issued != undefined && typeof item.issued === 'object') {
        if ('date-parts' in item.issued && Array.isArray(item.issued['date-parts'])) {
          const year = item.issued['date-parts'][0][0]
          date = ` (${year})`
        } else if ('literal' in item.issued) {
          date = ` (${item.issued.literal})`
        }
      }

      // This is just a very crude representation of the citations.
      return {
        citekey: item.id,
        displayText: `${authors}${date} - ${title}`
      }
    })

  currentEditor?.setCompletionDatabase('citations', items)
}

/**
 * Fetches the merged workspace reference state, selects the current file's
 * snapshot, and pushes its definitions as the typed 'references' completion
 * database (issue #1 Phase 3).
 */
async function updateReferenceEntries (): Promise<void> {
  const state: WorkspaceReferenceState = await ipcRenderer.invoke('reference-provider', {
    command: 'get-snapshot'
  })

  // The provider serves the whole merged workspace state; the completion
  // database for this editor is fed from the current file's snapshot.
  const snapshot = state.snapshots.find(candidate => candidate.documentPath === props.file.path)

  const entries: ReferenceCompletionEntry[] = (snapshot?.definitions ?? []).map(definition => ({
    key: definition.key,
    family: definition.family,
    title: definition.title,
    documentPath: definition.documentPath
  }))

  currentEditor?.setCompletionDatabase('references', entries)

  if (currentEditor === null) {
    return
  }

  // Additionally feed the resolved workspace reference view (issue #1
  // Phase 4): the current document's snapshot comes from a live extraction
  // of the local buffer (exact live ranges), which replaces the provider's
  // saved snapshot inside the merged workspace view.
  const liveSnapshot = extractReferences(props.file.path, currentEditor.value)
  const workspace = state.snapshots
    .filter(candidate => candidate.documentPath !== props.file.path)
    .concat([liveSnapshot])
  currentEditor.setWorkspaceReferences({
    snapshot: liveSnapshot,
    workspaceOccurrences: workspace.flatMap(candidate => candidate.occurrences),
    resolutions: resolveWorkspace(workspace)
  })
}

/**
 * Describes a typed rename rejection as closable-toast material.
 *
 * @param   {ReferenceRenameRejection}  reason  The typed rejection
 *
 * @return  {string}                            The user-facing message
 */
function describeRenameRejection (reason: ReferenceRenameRejection): string {
  switch (reason.kind) {
    case 'malformed-key':
      return trans('Cannot rename: "%s" is not a valid reference key.', reason.newKey)
    case 'family-changed':
      return trans('Cannot rename: references keep their family prefix ("%s:" cannot become "%s:").', reason.oldFamily, reason.newFamily)
    case 'collision':
      return trans('Cannot rename: %s is already defined in %s.', reason.newKey, reason.definitionPaths.join(', '))
    case 'unknown-key':
      return trans('Cannot rename: %s is not defined anywhere in this workspace.', reason.oldKey)
  }
}

/**
 * Offers the workspace rename for a directly edited definition id via a
 * non-blocking popup anchored at the edited token. Declining does nothing:
 * the local edit stays and the diagnostics flag the stale uses.
 *
 * @param   {ReferenceKeyEditPromptIntent}  intent  The prompt intent
 */
function promptWorkspaceRename (intent: ReferenceKeyEditPromptIntent): void {
  const view = currentEditor?.instance
  if (view === undefined || intent.documentPath !== props.file.path) {
    return
  }

  const coords = view.coordsAtPos(Math.min(intent.range.from, view.state.doc.length))
  const items: AnyMenuItem[] = [
    {
      label: trans('Rename "%s" to "%s" across the workspace…', intent.oldKey, intent.newKey),
      id: 'apply-workspace-rename',
      type: 'normal',
      action: () => {
        runWorkspaceRename(intent).catch(err => console.error('Workspace rename failed', err))
      }
    },
    {
      label: trans('Keep this edit only'),
      id: 'decline-workspace-rename',
      type: 'normal',
      action: () => { /* Declining does nothing further */ }
    }
  ]
  showPopupMenu({ x: coords?.left ?? 0, y: coords?.bottom ?? 0 }, items)
}

/**
 * Runs the confirmed workspace rename protocol: withdraws the local token
 * edit (the atomic workspace rename owns the whole change), previews, and
 * commits. Typed rejections and conflicts surface as closable toasts —
 * never as blocking dialogs.
 *
 * @param   {ReferenceKeyEditPromptIntent}  intent  The confirmed intent
 */
async function runWorkspaceRename (intent: ReferenceKeyEditPromptIntent): Promise<void> {
  const view = currentEditor?.instance
  if (view === undefined) {
    return
  }

  // Withdraw the local definition edit so the previewed rename computes
  // and applies the complete, consistent workspace edit set.
  view.dispatch({
    changes: { from: intent.range.from, to: intent.range.to, insert: '#' + intent.oldKey }
  })

  const preview: ReferenceRenamePreview = await ipcRenderer.invoke('application', {
    command: 'preview-reference-rename',
    payload: { oldKey: intent.oldKey, newKey: intent.newKey }
  })

  if (preview.status === 'rejected') {
    showToast(describeRenameRejection(preview.reason), 'error')
    return
  }

  const outcome: CommitRenameOutcome = await ipcRenderer.invoke('application', {
    command: 'commit-reference-rename',
    payload: { edit: preview.edit }
  })

  if (outcome.status === 'conflict') {
    showToast(trans(
      'Rename aborted: %s changed concurrently. No document was modified.',
      outcome.conflict.documentPath
    ), 'error')
    return
  }

  // Renderer half of the boundary split: apply this document's returned
  // open-buffer transactions (the buffer stays dirty/unsaved). When this
  // document was committed as a closed-file disk write instead, replay the
  // same edits locally so the buffer matches the rewritten disk content.
  const ownEdits = (outcome.openBufferTransactions.length > 0
    ? outcome.openBufferTransactions
    : preview.edit.edits
  ).filter(e => e.documentPath === intent.documentPath)
  if (ownEdits.length > 0) {
    view.dispatch({
      changes: ownEdits.map(e => ({ from: e.range.from, to: e.range.to, insert: e.insert }))
    })
  }

  showToast(trans(
    'Renamed %s to %s across %s documents.',
    intent.oldKey,
    intent.newKey,
    Object.keys(preview.edit.expectedSourceHashes).length
  ))
}

async function updateFileDatabase (): Promise<void> {
  // Get all our files ...
  const fileDatabase: Array<{ filename: string, displayName: string, id: string }> = []

  // ... and the unique links that are part of the link database
  const rawLinks: Record<string, string[]> = await ipcRenderer.invoke('link-provider', { command: 'get-link-database' })
  const linkDatabase = [...new Set(Object.values(rawLinks).flat())]

  // First, add all existing files to the database ...
  for (const file of fsalFiles.value) {
    let displayName = pathBasename(file.name, file.ext)
    if (useTitle.value && file.yamlTitle !== undefined) {
      displayName = file.yamlTitle
    } else if (useH1.value && file.firstHeading !== null) {
      displayName = file.firstHeading
    }
    fileDatabase.push({
      filename: pathBasename(file.name, file.ext),
      displayName,
      id: file.id
    })
  }

  // ... before going through the link database to add those links that link to
  // not yet existing files
  for (const link of linkDatabase) {
    const existingFile = fileDatabase.find(file => file.filename === link || file.id === link)
    if (existingFile === undefined) {
      fileDatabase.push({ filename: link, displayName: link, id: '' })
    }
  }

  currentEditor?.setCompletionDatabase('files', fileDatabase)
}

function maybeHighlightSearchResults (): void {
  if (currentEditor === null) {
    return
  }

  const result = globalSearchResults.value.find(r => r.file.path === props.file.path)
  if (result === undefined) {
    currentEditor.highlightRanges([])
    return
  }

  // Construct CodeMirror.Ranges from the results
  const rangesToHighlight = []
  // NOTE: We have to filter out "whole-file" results
  for (const res of result.result.filter((res): res is FileContentSearchResult => res.type === 'content' && res.line > -1)) {
    const startIdx = currentEditor.instance.state.doc.line(res.line + 1).from
    for (const range of res.ranges) {
      const { from, to } = range
      rangesToHighlight.push(EditorSelection.range(startIdx + from, startIdx + to))
    }
  }
  currentEditor.highlightRanges(rangesToHighlight)
}

</script>

<style lang="less">
// Editor Geometry

// Editor margins left and right for all breakpoints in both fullscreen and
// normal mode.
@editor-margin-fullscreen-sm:  50px;
@editor-margin-fullscreen-md:   5vw;
@editor-margin-fullscreen-lg:  10vw;
@editor-margin-fullscreen-xl:  20vw;
@editor-margin-fullscreen-xxl: 30vw;

.main-editor-wrapper {
  width: 100%;
  height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  background-color: #ffffff;
  transition: 0.2s background-color ease;
  position: relative;

  .cm-editor {
    .cm-scroller { padding: 50px 50px; }
    .cm-content { min-width: 0; }
  }

  // If a code file is loaded, we need to display the editor contents in monospace.
  &.code-file .cm-editor {
    font-family: Inconsolata, monospace;

    // Reset the margins for code files
    .cm-scroller { padding: 0px; }
  }
}

body.dark .main-editor-wrapper {
  background-color: #2b2b2c;
}

// CodeMirror fullscreen
.main-editor-wrapper.fullscreen {
  // This makes the editor pane show "fullscreen" on top over the rest of the UI
  // except the toolbar (due to a position: relative on the window content div).
  position: absolute;
  top: 0;

  .cm-scroller {
    @media(min-width: 1301px) { padding: 0 @editor-margin-fullscreen-xxl; }
    @media(max-width: 1300px) { padding: 0 @editor-margin-fullscreen-xl; }
    @media(max-width: 1100px) { padding: 0 @editor-margin-fullscreen-lg; }
    @media(max-width: 1000px) { padding: 0 @editor-margin-fullscreen-md; }
    @media(max-width:  800px) { padding: 0 @editor-margin-fullscreen-sm; }

  }
}

body.darwin {
    .main-editor-wrapper.fullscreen {
      border-top: 1px solid #d5d5d5;
  }

  &.dark {
    .main-editor-wrapper.fullscreen {
      border-top-color: #505050;
    }
  }
}

</style>
