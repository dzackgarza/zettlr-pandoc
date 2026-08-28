<template>
  <div
    ref="mainEditorWrapper"
    class="main-editor-wrapper"
    role="region"
    :aria-label="`Markdown Editor: Currently editing file ${pathBasename(props.file.path)}`"
    :style="{ 'font-size': `${fontSize}px` }"
    :class="{
      'code-file': !isMarkdown,
      fullscreen: distractionFree
    }"
  >
    <div :id="`cm-text-${props.leafId}`">
      <!-- This element will be replaced with Codemirror's wrapper element on mount -->
    </div>
    <RenameReferencePreviewDialog
      v-if="renamePreviewPrompt !== undefined"
      :old-key="renamePreviewPrompt.intent.oldKey"
      :new-key="renamePreviewPrompt.intent.newKey"
      :files="renamePreviewPrompt.files"
      @apply="applyWorkspaceRename()"
      @close="cancelWorkspaceRename()"
    />
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
import type { CreateReferenceLabelDialogPrompt, EditorCommands } from './component-contracts'
import { hasMarkdownExt } from '@common/util/file-extention-checks'
import { DP_EVENTS, type OpenDocument } from '@dts/common/documents'
import { CITEPROC_MAIN_DB } from '@dts/common/citeproc'
import { type EditorConfigOptions } from '@common/modules/markdown-editor/util/configuration'
import type { CodeFileDescriptor, DirDescriptor, MDFileDescriptor } from '@dts/common/fsal'
import { getBibliographyForDescriptor as getBibliography } from '@common/util/get-bibliography-for-descriptor'
import { EditorSelection } from '@codemirror/state'
import { documentAuthorityIPCAPI } from '@common/modules/markdown-editor/util/ipc-api'
import { ipcMarkdownFormatter, surfaceFormatResult } from '@common/modules/markdown-editor/commands/format-document-ipc'
import { useConfigStore, useDocumentTreeStore, useTagsStore, useWindowStateStore, useWorkspaceStore } from 'source/pinia'
import { isAbsolutePath, pathBasename, pathDirname, resolvePath } from '@common/util/renderer-path-polyfill'
import type { DocumentsUpdateContext } from 'source/app/service-providers/documents'
import type { ProjectInfo } from 'source/common/modules/markdown-editor/plugins/project-info-field'
import type { FileContentSearchResult } from 'source/app/service-providers/search'
import type { DocumentLocation, ProjectRootSpec, ReferenceCompletionEntry, SourceRange } from '@dts/common/references'
import type { ReviewDiffSession } from '@dts/common/review-diff'
import type { WorkspaceReferenceState } from 'source/app/service-providers/references/reference-index'
import { annotateCompletionEntries } from '@common/pandoc-util/project-reference-status'
import { trans } from '@common/i18n-renderer'
import showPopupMenu, { type AnyMenuItem } from '@common/modules/window-register/application-menu-helper'
import showToast from '@common/util/show-toast'
import { sha256Text } from '@common/util/sha256'
import type { ReferenceKeyEditPromptIntent } from '@common/modules/markdown-editor/plugins/reference-key-edit-prompt'
import type { ReferenceSearchRequest } from '@common/modules/markdown-editor/plugins/reference-search-effect'
import {
  confirmReferenceLabelInsertion,
  type ConfirmReferenceLabelOutcome,
  type CreateReferenceLabelIntent,
  type CreateReferenceLabelRequest
} from '@common/modules/markdown-editor/plugins/create-reference-label'
import { invokeReferenceProviderRecoverably } from './util/recoverable-reference-errors'
import { runRecoverably } from '@common/util/run-recoverably'
import surfaceDocumentLoadError, {
  surfaceDocumentLoadFailure
} from './util/surface-document-load-error'
import RenameReferencePreviewDialog from './RenameReferencePreviewDialog.vue'
import {
  buildRenamePreviewSummary,
  type CommitRenameOutcome,
  type ReferenceRenamePreview,
  type ReferenceRenameRejection,
  type RenamePreviewFileSummary,
  type UndoRenameOutcome
} from '@common/pandoc-util/compute-reference-edits'
import type { WorkspaceReferenceEdit } from '@dts/common/references'

const ipcRenderer = window.ipc

// Live-buffer reference state is owned by MAIN (issue #53): the document
// authority already streams every edit in through collab push-updates, and
// the references provider derives the live overlay from that authority
// text. This window reports nothing and keeps no per-document counters.

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

const emit = defineEmits<{
  (e: 'globalSearch', query: string): void
  (e: 'referenceSearch', request: ReferenceSearchRequest): void
  (e: 'createReferenceLabel', prompt: CreateReferenceLabelDialogPrompt): void
  (e: 'openPandocQuickHelp'): void
}>()

const windowStateStore = useWindowStateStore()
const documentTreeStore = useDocumentTreeStore()
const workspaceStore = useWorkspaceStore()
const configStore = useConfigStore()
const tagStore = useTagsStore()

// UNREFFED STUFF
let currentEditor: MarkdownEditor|null = null

function reportDocumentLoadError (error: unknown): void {
  surfaceDocumentLoadError(props.file.path, error)
}

/**
 * The navigation payload of the last ACTIVE_FILE event for this leaf
 * (issue #1 Phase 5): either the DocumentLocation of a restored Back/Forward
 * history entry, or the definition targetRange of a cross-file reference
 * jump. Applied once the editor for that file is loaded (or immediately when
 * it already is), then cleared.
 */
let pendingNavigation: { filePath: string, location?: DocumentLocation, targetRange?: SourceRange }|null = null
let pendingReviewDiffSession: ReviewDiffSession|null = null

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

function applyReviewDiffSession (session: ReviewDiffSession): void {
  if (session.documentPath !== props.file.path) {
    return
  }

  if (currentEditor === null) {
    pendingReviewDiffSession = session
    return
  }

  pendingReviewDiffSession = null
  currentEditor.startReviewDiffSession(session)
}

/**
 * The working-text hash a review decision is bound to. The sync comes first:
 * hashing before the pane's pending edits have reached the document authority
 * would bind text main has not been told about, and main would then refuse a
 * decision that was in fact current.
 */
async function syncedWorkingSha256 (editor: MarkdownEditor): Promise<string> {
  await editor.whenSynced()
  return sha256Text(editor.value)
}

/**
 * Surfaces a refused review mutation. Success changes nothing locally — the
 * provider's broadcast is the only thing that moves review state in this pane
 * — so this is the whole of the response handling. A refusal is toasted and
 * rethrown, which is what tells the widget to hand its controls back.
 */
function throwOnReviewRefusal (
  result: { ok: true }|{ ok: false, message: string }
): void {
  if (!result.ok) {
    showToast(trans(result.message), 'error')
    throw new Error(result.message)
  }
}

function fetchActiveReviewDiffSession (): void {
  ipcRenderer.invoke('documents-provider', {
    command: 'get-review-diff-session',
    payload: { path: props.file.path }
  })
    .then(session => {
      if (session !== undefined) {
        applyReviewDiffSession(session)
      }
    })
    .catch(err => console.error('Could not fetch active review-diff session', err))
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

// Combined @-completion label feed (issue #1). Mirrors the citation-keys
// feed above: whenever main broadcasts changed workspace references, fetch
// the snapshot and push the typed 'references' completion database.
// updateReferenceEntries() itself routes provider failures through the
// recoverable-error boundary (closable toast, typed outcome); this catch
// only guards against unexpected renderer-side faults.
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
    const doSave = (): void => {
      ipcRenderer.invoke('documents:save-file', { path: props.file.path })
        .then(result => {
          if (result.ok) {
            return
          }
          // The provider refuses saves it cannot perform (an unresolved review,
          // an external edit). It deliberately does not present this itself: a
          // blocking main-process modal freezes the app until dismissed. Show
          // the closable toast surface instead, and never swallow the reason.
          const message = result.refusal?.message ??
            trans('Could not save "%s".', pathBasename(props.file.path))
          console.error(
            `[MainEditor] Main refused to save ${props.file.path}` +
            (result.refusal !== undefined ? ` (${result.refusal.reason}): ${result.refusal.message}` : '')
          )
          showToast(message, 'error', 12000)
        })
        .catch(e => console.error(e))
    }

    // Format-on-save (issue #26): when enabled for a Markdown file, run flowmark
    // over the buffer first and wait for the format's collab update to reach the
    // document authority, so the on-disk write sees the formatted bytes. The
    // format is a single undo step, so one undo reverts an unwanted auto-format.
    //
    // A formatter that reports a typed failure (flowmark absent, bad exit) left
    // the buffer untouched, surfaceFormatResult tells the author why, and the
    // save proceeds on the unchanged text. But if the format DID change the
    // buffer and whenSynced cannot promise those bytes reached the authority,
    // saving would write the pre-format text and report an ordinary success —
    // the author would find out by diffing the file. Refuse the save and say so
    // instead; the buffer keeps the formatted text and pressing save again
    // retries the whole thing.
    if (configStore.config.editor.formatOnSave && isMarkdown.value && currentEditor !== undefined) {
      const editor = currentEditor
      editor.runFormatter(ipcMarkdownFormatter)
        .then(async result => {
          surfaceFormatResult(result)
          await editor.whenSynced()
          doSave()
        })
        .catch(e => {
          console.error(`[MainEditor] Format-on-save for ${props.file.path} did not complete; the file was NOT saved`, e)
          showToast(
            trans(
              'Could not save "%s": format-on-save did not complete, so nothing was written. Press save again.',
              pathBasename(props.file.path)
            ),
            'error',
            12000
          )
        })
    } else {
      doSave()
    }
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

  if (event === DP_EVENTS.FILE_REMOTE_CHANGE_ERROR && context.filePath === props.file.path) {
    if (context.documentLoadError === undefined) {
      throw new Error(
        `Received ${DP_EVENTS.FILE_REMOTE_CHANGE_ERROR} without a diagnostic for ${context.filePath}`
      )
    }
    surfaceDocumentLoadFailure(context.filePath, context.documentLoadError)
  } else if (event === DP_EVENTS.FILE_REMOTELY_CHANGED && context.filePath === props.file.path) {
    // The currently loaded document has been changed remotely. This event indicates
    // that the document provider has already reloaded the document and we only
    // need to tell the main editor to reload it as well.
    //
    // Drop the review first. notifyRemoteChange closed the provider-owned review
    // when it accepted the external edit, so this pane's session is already dead;
    // leaving it set would let the reload restore accept/reject controls over the
    // externally reloaded text. Rejecting one of those phantom chunks would
    // reinstate the stale review reference, and with the provider's review gone
    // the save gate would not stop that text being written over the external
    // edit.
    currentEditor?.clearReviewDiffSession()
    currentEditor?.reload().catch(reportDocumentLoadError)
  } else if (event === DP_EVENTS.FILE_SAVED && context.filePath === props.file.path) {
    // The file has been saved to disk. This means we should probably update the
    // descriptor to know of, e.g., library changes.
    ipcRenderer.invoke('fsal', { command: 'get-descriptor', payload: props.file.path })
      .then(descriptor => {
        if (descriptor === undefined || Array.isArray(descriptor) || (descriptor.type !== 'file' && descriptor.type !== 'code')) {
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
  } else if (
    event === DP_EVENTS.REVIEW_DIFF &&
    context.filePath === props.file.path &&
    context.reviewCleared === true
  ) {
    // Provider closed or completed the review — exit review mode
    currentEditor?.clearReviewDiffSession(context.reviewId)
  } else if (
    event === DP_EVENTS.REVIEW_DIFF &&
    context.filePath === props.file.path &&
    context.reviewDiffSession !== undefined &&
    !(context.windowId === props.windowId && context.leafId === props.leafId)
  ) {
    applyReviewDiffSession(context.reviewDiffSession)
  }
})

ipcRenderer.on('reload-editors', _e => {
  currentEditor?.reload().catch(reportDocumentLoadError)
})

// Update the file database whenever links have been updated
ipcRenderer.on('links', _e => {
  updateFileDatabase().catch(err => console.error('Could not update file database', err))
})

// MOUNTED HOOK
onMounted(() => {
  loadDocument().catch(reportDocumentLoadError)
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
    loadDocument().catch(reportDocumentLoadError)
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
    countChars: editor.countChars,
    navigationShortcuts: {
      back: editor.navigationShortcuts.back,
      forward: editor.navigationShortcuts.forward
    }
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
  const data = props.editorCommands.data
  if (typeof data !== 'object' || data === undefined || !('filePath' in data)) {
    return // The toggled command carried no jump payload
  }

  // Execute a jtl-command if the current displayed file is the correct one
  if (data.filePath === props.file.path) {
    jtl(data.lineNumber)
  }
})

watch(toRef(props.editorCommands, 'moveSection'), () => {
  if (props.activeFile?.path !== props.file.path || documentTreeStore.lastLeafId !== props.leafId) {
    return
  }

  const data = props.editorCommands.data
  if (typeof data === 'object' && data !== undefined && 'from' in data) {
    currentEditor?.moveSection(data.from, data.to)
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

  const data = props.editorCommands.data
  if (typeof data !== 'string') {
    return // The toggled command carried no command identifier
  }
  currentEditor.runCommand(data)
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

  const data = props.editorCommands.data
  if (typeof data !== 'string') {
    return // The toggled command carried no text payload
  }
  currentEditor?.replaceSelection(data)
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

  const data = props.editorCommands.data
  if (
    typeof data === 'object' && data !== undefined && 'type' in data &&
    (data.type === 'div' || data.type === 'span')
  ) {
    currentEditor?.insertPandocDivOrSpan(data.type, data.attributes)
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

  editor.on('document-load-error', reportDocumentLoadError)

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

  // The pane's one path to a review decision. Nothing here mutates review
  // state: the provider owns it, and its broadcast is what redraws the
  // widgets. Every call binds the decision to the generation the widgets were
  // drawn from and to the exact bytes the reviewer is looking at, so a
  // decision formed against a stale pane is refused instead of landing on a
  // chunk that moved.
  editor.setReviewActionClient({
    decide: async input => {
      throwOnReviewRefusal(await ipcRenderer.invoke('documents:decide-review-chunk', {
        reviewId: input.reviewId,
        chunkId: input.chunkId,
        decision: input.decision,
        expectedReviewGeneration: input.expectedReviewGeneration,
        expectedWorkingSha256: await syncedWorkingSha256(editor)
      }))
    },
    commentChunk: async input => {
      // Annotation, not adjudication — but the chunk id is content-addressed
      // over the working text, so it fences exactly like a decision.
      throwOnReviewRefusal(await ipcRenderer.invoke('documents:comment-review-chunk', {
        reviewId: input.reviewId,
        chunkId: input.chunkId,
        text: input.text,
        expectedReviewGeneration: input.expectedReviewGeneration,
        expectedWorkingSha256: await syncedWorkingSha256(editor)
      }))
    },
    acceptAll: async input => {
      throwOnReviewRefusal(await ipcRenderer.invoke('documents:accept-all-review-chunks', {
        reviewId: input.reviewId,
        expectedReviewGeneration: input.expectedReviewGeneration,
        expectedWorkingSha256: await syncedWorkingSha256(editor)
      }))
    },
    clear: async input => {
      throwOnReviewRefusal(await ipcRenderer.invoke('documents:clear-review', {
        reviewId: input.reviewId,
        expectedReviewGeneration: input.expectedReviewGeneration,
        expectedWorkingSha256: await syncedWorkingSha256(editor)
      }))
    },
    comment: async input => {
      // A comment adjudicates nothing and moves no text, so it fences on the
      // review generation alone and needs no sync.
      throwOnReviewRefusal(await ipcRenderer.invoke('documents:add-review-comment', {
        reviewId: input.reviewId,
        text: input.text,
        expectedReviewGeneration: input.expectedReviewGeneration
      }))
    }
  })

  editor.on('focus', () => {
    ipcRenderer.invoke('documents-provider', {
      command: 'focus-leaf',
      payload: {
        leafId: props.leafId,
        windowId: props.windowId
      }
    }).catch(err => console.error(err))

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

  // The workspace reference search overlay was requested (issue #1 Phase
  // 3b) — plain Mod-P (null) or a count badge's keyed reverse lookup
  // ({ key }, Phase 8); relay the request payload up the component tree to
  // App.vue.
  editor.on('reference-search', (request: ReferenceSearchRequest) => {
    emit('referenceSearch', request)
  })

  // An in-editor help link (the completion info panel, issue #1 review A2)
  // requested the searchable Pandoc quick help: relay up to App.vue's
  // PandocQuickHelp mount — the same surface the Help menu opens.
  editor.on('pandoc-quick-help', () => {
    emit('openPandocQuickHelp')
  })

  // A keystroke (Mod-Alt-l) requested a flowmark format (issue #26). Run the
  // IPC format here in the renderer and surface any absence/error as a toast.
  editor.on('format-document', () => {
    editor.runFormatter(ipcMarkdownFormatter)
      .then(surfaceFormatResult)
      .catch(e => { console.error('Format document failed', e) })
  })

  // The context menu (or command registry) requested the create-label
  // dialog for a resolved target (issue #1 Phase 6): relay the typed
  // request up to App.vue's dialog mount together with the closure that
  // performs the insertion once the dialog confirms a key. The closure
  // re-resolves the target in the CURRENT document (issue #1 Phase 8): the
  // dialog is modal only visually, so the request-time offsets are never
  // applied verbatim, and a stale target inserts nothing.
  editor.on('create-reference-label', (request: CreateReferenceLabelRequest) => {
    emit('createReferenceLabel', {
      family: request.family,
      proposedSlug: request.proposedSlug,
      applyCreate: (intent: CreateReferenceLabelIntent): ConfirmReferenceLabelOutcome => {
        const view = currentEditor?.instance
        if (view === undefined) {
          return { status: 'stale', reason: 'target-vanished' }
        }
        const outcome = confirmReferenceLabelInsertion(view, request)
        if (outcome.status === 'applied') {
          const { from, to, prefix, suffix } = outcome.insertion
          view.dispatch({ changes: { from, to, insert: prefix + intent.insertText + suffix } })
        }
        return outcome
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
  try {
    await newEditor.ready
  } catch (error) {
    newEditor.unmount()
    if (currentEditor === newEditor) {
      currentEditor = null
    }
    throw error
  }

  currentEditor.setCompletionDatabase('tags', tags.value)
  currentEditor.setCompletionDatabase('snippets', snippets.value)

  maybeHighlightSearchResults()

  const descriptor = await ipcRenderer.invoke('fsal', { command: 'get-descriptor', payload: props.file.path })
  if (descriptor === undefined || Array.isArray(descriptor) || (descriptor.type !== 'file' && descriptor.type !== 'code')) {
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
  await updateReferenceEntries()

  if (pendingReviewDiffSession !== null) {
    applyReviewDiffSession(pendingReviewDiffSession)
  } else {
    fetchActiveReviewDiffSession()
  }
}

function jtl (lineNumber: number): void {
  currentEditor?.jtl(lineNumber)
}

/** A CSL name field: persons carry family names, institutions a literal. */
interface CSLNameField {
  family?: unknown
  literal?: unknown
}

/** Narrows a CSL item's author/editor field to a usable name list. */
function isNameList (value: unknown): value is CSLNameField[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'object' && entry !== null)
}

/** The year (or literal date) of a CSL item's issued field, if present. */
function formatIssuedDate (issued: unknown): string {
  if (typeof issued !== 'object' || issued === null) {
    return ''
  }

  const dateParts = (issued as { 'date-parts'?: unknown })['date-parts']
  if (Array.isArray(dateParts) && Array.isArray(dateParts[0])) {
    const year: unknown = dateParts[0][0]
    if (typeof year === 'number' || typeof year === 'string') {
      return ` (${year})`
    }
  }

  const literal = (issued as { literal?: unknown }).literal
  if (typeof literal === 'string' || typeof literal === 'number') {
    return ` (${literal})`
  }

  return ''
}

async function updateCitationKeys (library: string): Promise<void> {
  const items = (await ipcRenderer.invoke('citeproc-provider', {
    command: 'get-items',
    payload: { database: library }
  }))
    .map(item => {
      // Get a rudimentary author list. Precedence are authors, then editors.
      // Fallback: Container title.
      let authors = ''
      const authorSrc = isNameList(item.author)
        ? item.author
        : isNameList(item.editor) ? item.editor : []

      if (authorSrc.length > 0) {
        authors = authorSrc.map(author => {
          if (typeof author.family === 'string') {
            return author.family
          } else if (typeof author.literal === 'string') {
            return author.literal
          } else {
            return undefined
          }
        }).filter(elem => elem !== undefined).join(', ')
      } else if (typeof item['container-title'] === 'string') {
        authors = item['container-title']
      }

      let title = ''
      if (typeof item.title === 'string') {
        title = item.title
      } else if (typeof item['container-title'] === 'string') {
        title = item['container-title']
      }

      const date = formatIssuedDate(item.issued)

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
/**
 * Every Project root visible in the workspace, projected to the pure
 * ProjectRootSpec shape the reference-status computation consumes (issue #1
 * Phase 7): a DirDescriptor with non-null settings.project maps to its
 * absolute path plus the ordered project-relative ProjectSettings.files list.
 */
function collectProjectRoots (): ProjectRootSpec[] {
  const roots: ProjectRootSpec[] = []
  for (const descriptor of workspaceStore.descriptorMap.values()) {
    if (descriptor.type === 'directory' && descriptor.settings.project !== null) {
      roots.push({
        rootPath: descriptor.path,
        files: [...descriptor.settings.project.files]
      })
    }
  }
  return roots
}

async function updateReferenceEntries (): Promise<void> {
  // Routed through the recoverable-error boundary (issue #1 Phase 8): a
  // failed fetch surfaces one closable toast and the editor keeps its last
  // known reference state — never a fabricated fallback, never an
  // uncloseable overlay.
  const outcome = await invokeReferenceProviderRecoverably<WorkspaceReferenceState>(
    async (channel, message) => await ipcRenderer.invoke(channel, message),
    { command: 'get-snapshot' },
    trans('Loading workspace references')
  )
  if (outcome.status === 'failed') {
    return
  }
  const state = outcome.value

  // The provider serves the whole merged workspace state; the completion
  // database for this editor is fed from EVERY document's definitions,
  // annotated with their Project-membership status relative to this editor's
  // document and the visible Project roots (issue #1 Phase 7).
  const projectRoots = collectProjectRoots()

  const rawEntries: ReferenceCompletionEntry[] = state.snapshots
    .flatMap(candidate => candidate.definitions)
    .map(definition => ({
      key: definition.key,
      family: definition.family,
      title: definition.title,
      documentPath: definition.documentPath
    }))
  const entries = annotateCompletionEntries(rawEntries, props.file.path, projectRoots)

  currentEditor?.setCompletionDatabase('references', entries)

  if (currentEditor === null) {
    return
  }

  // The main-process reference provider owns the live buffer overlay. Do not
  // extract a parallel snapshot from the renderer: that would let an editor
  // pane diverge from the authority used by citing and rename operations.
  const liveSnapshot = state.snapshots.find(candidate => candidate.documentPath === props.file.path)
  if (liveSnapshot === undefined) {
    return
  }
  const workspace = state.snapshots
  currentEditor.setWorkspaceReferences({
    snapshot: liveSnapshot,
    workspaceOccurrences: workspace.flatMap(candidate => candidate.occurrences),
    resolutions: state.resolutions,
    projectRoots
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
        // A failed rename protocol run surfaces through the recoverable
        // boundary (review B8): one closable error toast, never a silent
        // console-only line.
        void runRecoverably(async () => { await runWorkspaceRename(intent) }, trans('Workspace rename'))
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
 * The pending rename preview shown by the dialog (issue #1, review A4):
 * the confirmed intent, the previewed workspace edit, and the per-file
 * affected-occurrence summary. Nothing commits while this is pending —
 * Apply commits, Cancel restores the authored local edit.
 */
interface RenamePreviewPrompt {
  intent: ReferenceKeyEditPromptIntent
  edit: WorkspaceReferenceEdit
  files: RenamePreviewFileSummary[]
}

const renamePreviewPrompt = ref<RenamePreviewPrompt|undefined>(undefined)

/**
 * Runs the confirmed workspace rename protocol up to the PREVIEW (issue #1,
 * review A4 / US-17): withdraws the local token edit (the atomic workspace
 * rename owns the whole change), previews, and presents the affected
 * occurrences in the rename-preview dialog. Nothing commits here — Apply
 * in the dialog commits, Cancel restores the authored edit. Typed
 * rejections surface as closable toasts, never as blocking dialogs.
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

  // The per-file summary is built over the same merged workspace state the
  // preview was computed from (the provider's snapshots carry the authored
  // previewSource/clusterRaw context the dialog shows).
  const outcome = await invokeReferenceProviderRecoverably<WorkspaceReferenceState>(
    async (channel, message) => await ipcRenderer.invoke(channel, message),
    { command: 'get-snapshot' },
    trans('Loading workspace references')
  )
  if (outcome.status === 'failed') {
    return // The boundary surfaced the closable toast; the withdrawal stays.
  }

  renamePreviewPrompt.value = {
    intent,
    edit: preview.edit,
    files: buildRenamePreviewSummary(preview.edit, outcome.value.snapshots, intent.oldKey)
  }
}

/**
 * Cancels the pending rename at the preview stage: nothing was committed,
 * and the user's authored key edit is restored so declining here equals
 * declining the original prompt (the diagnostics flag the stale uses).
 */
function cancelWorkspaceRename (): void {
  const prompt = renamePreviewPrompt.value
  renamePreviewPrompt.value = undefined
  const view = currentEditor?.instance
  if (prompt === undefined || view === undefined) {
    return
  }

  const { intent } = prompt
  const from = intent.range.from
  const to = from + ('#' + intent.oldKey).length
  if (view.state.doc.sliceString(from, to) === '#' + intent.oldKey) {
    view.dispatch({ changes: { from, to, insert: '#' + intent.newKey } })
  }
}

/**
 * Applies the previewed workspace rename (the dialog's Apply all): the
 * hash-fenced atomic commit and the confirmation toast carrying the
 * reachable Undo (issue #1, review A5 / US-17). The central document
 * authority applies every open-buffer transaction and acknowledges it
 * before the command returns; every renderer receives the resulting collab
 * update. Conflicts surface as closable toasts.
 */
async function applyWorkspaceRename (): Promise<void> {
  const prompt = renamePreviewPrompt.value
  renamePreviewPrompt.value = undefined
  const view = currentEditor?.instance
  if (prompt === undefined || view === undefined) {
    return
  }
  const { intent, edit } = prompt

  const outcome: CommitRenameOutcome = await ipcRenderer.invoke('application', {
    command: 'commit-reference-rename',
    payload: { edit }
  })

  if (outcome.status === 'conflict') {
    showToast(trans(
      'Rename aborted: %s changed concurrently. No document was modified.',
      outcome.conflict.documentPath
    ), 'error')
    return
  }

  showToast(
    trans(
      'Renamed %s to %s across %s documents.',
      intent.oldKey,
      intent.newKey,
      Object.keys(edit.expectedSourceHashes).length
    ),
    'info',
    8000,
    {
      label: trans('Undo'),
      onAction: () => {
        undoWorkspaceRename().catch(err => console.error('Workspace rename undo failed', err))
      }
    }
  )
}

/**
 * Invokes the production rename-undo route (issue #1, review A5): the
 * 'application' channel's 'undo-reference-rename' command reaches the
 * reference provider's one-shot, hash-fenced undoRename(). The document
 * authority applies and acknowledges every open-buffer inverse before the
 * command returns; conflicts and a consumed record surface as closable
 * toasts.
 */
async function undoWorkspaceRename (): Promise<void> {
  const outcome: UndoRenameOutcome = await ipcRenderer.invoke('application', {
    command: 'undo-reference-rename'
  })

  if (outcome.status === 'no-pending-undo') {
    showToast(trans('Nothing to undo: no workspace rename is pending.'), 'error')
    return
  }

  if (outcome.status === 'conflict') {
    showToast(trans(
      'Undo aborted: %s changed after the rename. No document was modified.',
      outcome.conflict.documentPath
    ), 'error')
    return
  }

  showToast(trans('Workspace rename undone.'))
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
