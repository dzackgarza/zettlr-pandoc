<template>
  <WindowChrome
    :title="windowTitle"
    :titlebar="shouldShowTitlebar"
    :menubar="shouldShowMenubar"
    :disable-vibrancy="!hasVibrancy"
  >
    <!-- The three panes under one splitter (D8): sidebar, editor, panel. -->
    <SplitterGroup
      direction="horizontal"
      class="main-panes"
    >
      <SplitterPanel
        v-if="fileManagerVisible"
        class="main-pane"
        data-pane="navigation-sidebar"
        size-unit="px"
        :order="0"
        :min-size="NAVIGATION_SIDEBAR_MINIMUM"
        :default-size="mountWidths.navigationSidebar"
        @resize="draggedWidths.navigationSidebar = $event"
      >
        <NavigationSidebar
          ref="navigationSidebar"
          :window-id="windowId"
          @jump-to-line="jtl($event.filePath, $event.line, false)"
          @jtl="(filePath, lineNumber, newTab) => jtl(filePath, lineNumber, newTab)"
          @jump-to-active-line="genericJtl($event)"
          @move-section="moveSection($event)"
        />
      </SplitterPanel>
      <SplitterResizeHandle
        v-if="fileManagerVisible"
        class="main-pane-handle"
        data-pane-handle="navigation-sidebar"
        @dragging="onPaneDragging('navigationSidebar', $event)"
      />
      <SplitterPanel
        class="main-pane"
        data-pane="editor"
        :order="1"
        :min-size="EDITOR_MINIMUM_PERCENT"
      >
        <EditorPane
          v-if="paneConfiguration?.type === 'leaf'"
          :node="paneConfiguration"
          :leaf-id="paneConfiguration.id"
          :editor-commands="editorCommands"
          :window-id="windowId"
          @global-search="startGlobalSearch($event)"
          @reference-search="openReferenceSearch($event)"
          @create-reference-label="openCreateReferenceLabel($event)"
          @open-pandoc-quick-help="showPandocQuickHelp = true"
        />
        <EditorBranch
          v-else-if="paneConfiguration !== undefined"
          :node="paneConfiguration"
          :window-id="windowId"
          :editor-commands="editorCommands"
          :is-last="true"
          @global-search="startGlobalSearch($event)"
          @reference-search="openReferenceSearch($event)"
          @create-reference-label="openCreateReferenceLabel($event)"
          @open-pandoc-quick-help="showPandocQuickHelp = true"
        />
      </SplitterPanel>
      <SplitterResizeHandle
        v-if="sidebarVisible"
        class="main-pane-handle"
        data-pane-handle="annotation-panel"
        @dragging="onPaneDragging('annotationPanel', $event)"
      />
      <SplitterPanel
        v-if="sidebarVisible"
        class="main-pane"
        data-pane="annotation-panel"
        size-unit="px"
        :order="2"
        :min-size="ANNOTATION_PANEL_MINIMUM"
        :default-size="mountWidths.annotationPanel"
        @resize="draggedWidths.annotationPanel = $event"
      >
        <AnnotationsTab
          @jump-to-line="genericJtl($event)"
          @begin-reattach="beginAnnotationReattach($event)"
          @close="configStore.setConfigValue('window.sidebarVisible', false)"
        />
      </SplitterPanel>
    </SplitterGroup>
    <template #statusbar>
      <MainStatusbar
        :pomodoro-ratio="pomodoro.phase.elapsed / pomodoro.durations[pomodoro.phase.type]"
        :pomodoro-colour="pomodoro.colour[pomodoro.phase.type]"
        :update-available="isUpdateAvailable"
        @pomodoro="togglePomodoroPopover()"
        @tasks="toggleTasksPopover()"
        @update="openUpdater()"
        @toggle-readability="runEditorCommand('toggleReadabilityMode')"
        @toggle-lint-panel="runEditorCommand('toggleLintPanel')"
        @set-language-tool-language="setLanguageToolLanguage($event)"
        @open-file="openWorkspaceFile($event)"
      />
    </template>
  </WindowChrome>

  <!-- Full-screen lightbox for rendered TikZ figures (issue #14) -->
  <TikzLightbox />

  <!-- Popover area: these will be teleported to the body element anyhow -->
  <PopoverPomodoro
    v-if="showPomodoroPopover && pomodoroButton !== null"
    :target="pomodoroButton"
    :pomodoro="pomodoro"
    :sound-effects="SOUND_EFFECTS"
    @close="showPomodoroPopover = false"
    @config="setPomodoroConfig($event)"
    @start="startPomodoro()"
    @stop="stopPomodoro()"
  />
  <PopoverLRT
    v-if="showTasksPopover && tasksButton !== null"
    :target="tasksButton"
    @close="showTasksPopover = false"
  />
  <PandocQuickHelp
    v-if="showPandocQuickHelp"
    @close="showPandocQuickHelp = false"
  />
  <CommandLauncher
    ref="commandLauncher"
    @open-file="openWorkspaceFile($event)"
    @jump-to-line="genericJtl($event)"
    @jump="handleReferenceJump($event)"
    @open-help="showPandocQuickHelp = true"
    @export="runExport($event)"
  />
  <CreateReferenceLabelDialog
    v-if="createLabelPrompt !== undefined"
    :family="createLabelPrompt.family"
    :proposed-slug="createLabelPrompt.proposedSlug"
    :existing-keys="createLabelExistingKeys"
    @close="createLabelPrompt = undefined"
    @create="handleCreateReferenceLabel($event)"
  />
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        App
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This is the entry component for the main window.
 *
 * END HEADER
 */

import WindowChrome from '@common/vue/window/WindowChrome.vue'
import NavigationSidebar from './sidebar/NavigationSidebar.vue'
import AnnotationsTab from './sidebar/AnnotationsTab.vue'
import EditorPane from './EditorPane.vue'
import EditorBranch from './EditorBranch.vue'
import { SplitterGroup, SplitterPanel, SplitterResizeHandle } from 'reka-ui'
import TikzLightbox from './TikzLightbox.vue'
import PopoverPomodoro from './PopoverPomodoro.vue'
import PandocQuickHelp from './PandocQuickHelp.vue'
import MainStatusbar from './MainStatusbar.vue'
import { HEADER_LEAF_ID, headerLeafId } from './header-leaf'
import type { ExportRequest } from './launcher/launcher-rows'
import type { CustomExportIPCAPI, ExportIPCAPI } from 'source/app/service-providers/commands/export'
import CommandLauncher from './launcher/CommandLauncher.vue'
import type { LauncherView } from './launcher/launcher-state'
import type { RevealTarget } from './sidebar/sidebar-modules'
import CreateReferenceLabelDialog from './CreateReferenceLabelDialog.vue'
import type {
  ConfirmReferenceLabelOutcome,
  CreateReferenceLabelIntent
} from '@common/modules/markdown-editor/plugins/create-reference-label'
import type { ReferenceSearchRequest } from '@common/modules/markdown-editor/plugins/reference-search-effect'
import { invokeReferenceProviderRecoverably } from './util/recoverable-reference-errors'
import type {
  CreateReferenceLabelDialogPrompt,
  EditorCommands,
  PomodoroConfig,
  ReferenceJumpIntent
} from './component-contracts'
import showToast from '@common/util/show-toast'
import { trans } from '@common/i18n-renderer'
import localiseNumber from '@common/util/localise-number'
import generateId from '@common/util/generate-id'
import {
  nextTick,
  ref,
  computed,
  provide,
  watch,
  onMounted,
  reactive
} from 'vue'

// Import the sound effects for the pomodoro timer
import glassFile from './assets/glass.wav'
import alarmFile from './assets/digital_alarm.mp3'
import chimeFile from './assets/chime.mp3'
import { DocumentType, type LeafNodeJSON } from '@dts/common/documents'
import { buildPipeMarkdownTable } from '@common/util/build-pipe-markdown-table'
import { type UpdateState } from '@providers/updates'
import getDocumentTitle from './util/get-document-title'
import { useConfigStore, useDocumentTreeStore, useWindowStateStore, useWorkspaceStore } from 'source/pinia'
import { type AnyDescriptor } from 'source/types/common/fsal'
import type { WorkspaceReferenceState } from 'source/app/service-providers/references/reference-index'
import { SAVE_REFUSED_CHANNEL, type SaveRefusedBroadcast } from '@dts/common/documents'
import { pathBasename } from '@common/util/renderer-path-polyfill'
import PopoverLRT from './PopoverLRT.vue'
import {
  insertTablePayloadSchema,
  isEditorCommandName,
  isShortcutName,
  type EditorCommandName,
  type ShortcutName
} from '@dts/common/shortcut-names'

const ipcRenderer = window.ipc

const configStore = useConfigStore()
const documentTreeStore = useDocumentTreeStore()
const windowStateStore = useWindowStateStore()
const workspaceStore = useWorkspaceStore()

const SOUND_EFFECTS = [
  {
    file: glassFile,
    label: 'Glass'
  },
  {
    file: alarmFile,
    label: 'Digital Alarm'
  },
  {
    file: chimeFile,
    label: 'Chime'
  }
]

const searchParams = new URLSearchParams(window.location.search)
// The window number indicates which main window this one here is. This is only
// necessary for the documents and split views to show up.
const windowId = searchParams.get('window_id')!

const fileManagerVisible = computed<boolean>(() => configStore.config.window.fileManagerVisible)
const isUpdateAvailable = ref(false)
const hasVibrancy = computed(() => configStore.config.window.vibrancy && process.platform === 'darwin')

// The panes' widths. The sidebar and the panel are pixel panels with a
// minimum each; the editor takes the rest, down to a fifth of the window,
// below which a shrinking window squeezes the pixel panes too. A pane
// mounts at the width it was last dragged to, in this session or in the
// config, and a drag's end persists it — a window that squeezes the panes
// does not overwrite the width the user chose.
const NAVIGATION_SIDEBAR_MINIMUM = 200
const ANNOTATION_PANEL_MINIMUM = 240
const EDITOR_MINIMUM_PERCENT = 20

type DraggablePane = 'navigationSidebar' | 'annotationPanel'
const PANE_WIDTH_KEY: Record<DraggablePane, 'ui.navigationSidebarWidth' | 'ui.annotationPanelWidth'> = {
  navigationSidebar: 'ui.navigationSidebarWidth',
  annotationPanel: 'ui.annotationPanelWidth'
}
/** The width each pane mounts at; moves only when a drag ends. */
const mountWidths = reactive<Record<DraggablePane, number>>({
  navigationSidebar: configStore.config.ui.navigationSidebarWidth,
  annotationPanel: configStore.config.ui.annotationPanelWidth
})
/** The width each pane has right now, as the splitter reports it. */
const draggedWidths = reactive<Record<DraggablePane, number>>({ ...mountWidths })
/** Which handles are mid-drag: only a drag that happened persists a width. */
const paneDragActive = reactive<Record<DraggablePane, boolean>>({ navigationSidebar: false, annotationPanel: false })

function onPaneDragging (pane: DraggablePane, dragging: boolean): void {
  if (dragging) {
    paneDragActive[pane] = true
    return
  }
  if (!paneDragActive[pane]) {
    return
  }
  paneDragActive[pane] = false
  const width = Math.round(draggedWidths[pane])
  mountWidths[pane] = width
  configStore.setConfigValue(PANE_WIDTH_KEY[pane], width)
}

// Popover targets: the status bar items, looked up when their popover opens.
const pomodoroButton = ref<HTMLElement|null>(null)
const showPomodoroPopover = ref<boolean>(false)
const tasksButton = ref<HTMLElement|null>(null)
const showTasksPopover = ref(false)
const showPandocQuickHelp = ref<boolean>(false)

function togglePomodoroPopover (): void {
  pomodoroButton.value = document.querySelector('#statusbar-pomodoro')
  showPomodoroPopover.value = !showPomodoroPopover.value
}

function toggleTasksPopover (): void {
  tasksButton.value = document.querySelector('#main-statusbar [data-statusbar-item="tasks"]')
  showTasksPopover.value = !showTasksPopover.value
}

/** Runs a named editor command in the last focused pane. */
function runEditorCommand (name: EditorCommandName): void {
  editorCommands.value.data = name
  editorCommands.value.executeCommand = !editorCommands.value.executeCommand
}

/** Overrides the language LanguageTool checks the focused pane's document in. */
function setLanguageToolLanguage (language: string): void {
  editorCommands.value.data = language
  editorCommands.value.setLanguageToolLanguage = !editorCommands.value.setLanguageToolLanguage
}

async function openUpdater (): Promise<void> {
  await ipcRenderer.invoke('application', { command: 'open-update-window' })
}

/** The surface CommandLauncher.vue exposes to its template ref. */
interface CommandLauncherHandle {
  open: (view: LauncherView) => Promise<void>
  close: () => void
}

const commandLauncher = ref<CommandLauncherHandle|null>(null)

/**
 * Opens the command launcher for a reference search request: the plain
 * Mod-P request (null) opens the launcher root, where the workspace
 * reference search is one command; the badge-keyed reverse lookup
 * ({ key }, issue #1 Phase 8) opens the references view on that key.
 *
 * @param   {ReferenceSearchRequest}  request  The relayed request payload
 */
async function openReferenceSearch (request: ReferenceSearchRequest = null): Promise<void> {
  const view: LauncherView = request === null ? { kind: 'root' } : { kind: 'references', request }
  await commandLauncher.value?.open(view)
}

/** Opens the launcher on the export profiles: the Export… menu item's path. */
async function openExport (): Promise<void> {
  await commandLauncher.value?.open({ kind: 'dynamic-group', id: 'export' })
}

/** Exports the active document with the profile or custom command chosen in the launcher. */
async function runExport (request: ExportRequest): Promise<void> {
  const file = activeFile.value
  if (file === undefined) {
    return
  }
  if (request.kind === 'command') {
    await ipcRenderer.invoke('application', {
      command: 'custom-export',
      payload: { displayName: request.displayName, file: file.path } satisfies CustomExportIPCAPI
    })
    return
  }
  await ipcRenderer.invoke('application', {
    command: 'export',
    payload: {
      // Spread into a plain object: the reactive proxy cannot cross the IPC boundary.
      profile: { ...request.profile },
      exportTo: configStore.config.export.dir,
      file: file.path
    } satisfies ExportIPCAPI
  })
}

/**
 * Opens a workspace document chosen in the launcher's Go to file group in
 * the last focused pane.
 *
 * @param   {string}  path  The document's path
 */
async function openWorkspaceFile (path: string): Promise<void> {
  await ipcRenderer.invoke('documents-provider', {
    command: 'open-file',
    payload: { path, windowId, leafId: lastLeafId.value, newTab: false }
  })
}

// Create-reference-label dialog (issue #1 Phase 6): the relayed request
// carries the fixed family, the slug proposal, and the editor-owned
// insertion closure; the workspace key set feeds the live uniqueness verdict.
const createLabelPrompt = ref<CreateReferenceLabelDialogPrompt|undefined>(undefined)
const createLabelExistingKeys = ref<string[]>([])

/**
 * Fetches the current workspace definition keys from the reference provider
 * (the live uniqueness verdict's data) and mounts the create-label dialog
 * over the relayed request.
 *
 * @param   {CreateReferenceLabelDialogPrompt}  prompt  The relayed request
 */
function openCreateReferenceLabel (prompt: CreateReferenceLabelDialogPrompt): void {
  invokeReferenceProviderRecoverably<WorkspaceReferenceState>(
    async (channel, message) => await ipcRenderer.invoke(channel, message),
    { command: 'get-snapshot' },
    trans('Loading workspace references')
  )
    .then(outcome => {
      if (outcome.status === 'failed') {
        return // The boundary surfaced the closable toast; nothing to open.
      }
      createLabelExistingKeys.value = outcome.value.snapshots
        .flatMap(snapshot => snapshot.definitions)
        .map(definition => definition.key)
      createLabelPrompt.value = prompt
    })
    .catch(err => console.error('Could not open the create-reference-label dialog', err))
}

/**
 * Describes a stale confirm-time outcome as closable-toast material
 * (issue #1 Phase 8): the document shifted while the dialog was open and
 * the insertion did NOT happen.
 *
 * @param   {ConfirmReferenceLabelOutcome}  outcome  The stale outcome
 *
 * @return  {string}                                 The user-facing message
 */
function describeStaleCreateOutcome (outcome: ConfirmReferenceLabelOutcome & { status: 'stale' }): string {
  switch (outcome.reason) {
    case 'already-labeled':
      return trans('No label created: the target gained a label while the dialog was open.')
    case 'target-vanished':
      return trans('No label created: the target no longer exists in the document.')
  }
}

/**
 * Acts on the dialog's single create intent: the editor re-resolves the
 * target in the CURRENT document and inserts the explicit label token
 * (issue #1 Phase 8), the @-reference lands on the clipboard, and a
 * closable toast confirms both. A stale outcome inserted nothing and
 * surfaces as a closable error toast instead.
 *
 * @param   {CreateReferenceLabelIntent}  intent  The confirmed intent
 */
function handleCreateReferenceLabel (intent: CreateReferenceLabelIntent): void {
  const prompt = createLabelPrompt.value
  createLabelPrompt.value = undefined
  if (prompt === undefined) {
    return
  }

  const outcome: ConfirmReferenceLabelOutcome = prompt.applyCreate(intent)
  if (outcome.status === 'stale') {
    showToast(describeStaleCreateOutcome(outcome), 'error')
    return
  }

  navigator.clipboard.writeText(intent.clipboardText)
    .then(() => {
      showToast(trans('Created %s — %s copied to the clipboard.', intent.key, intent.clipboardText))
    })
    .catch(err => {
      console.error('Could not copy the reference to the clipboard', err)
      showToast(trans('Created %s. The clipboard copy failed.', intent.key), 'error')
    })
}

/**
 * Acts on a jump intent chosen in the reference search overlay: closes the
 * overlay and opens the target document, landing on the intent's exact
 * range through the Phase 5 targetRange navigation — the definition's id
 * token for the Mod-P search, the occurrence's own range for the keyed
 * citing-locations reverse lookup.
 *
 * @param   {ReferenceJumpIntent}  intent  The chosen jump intent
 */
function handleReferenceJump (intent: ReferenceJumpIntent): void {
  ipcRenderer.invoke('documents-provider', {
    command: 'open-file',
    payload: {
      path: intent.documentPath,
      windowId,
      leafId: lastLeafId.value,
      newTab: false,
      targetRange: intent.range
    }
  })
    .catch(err => console.error(err))
}

const pomodoro = ref<PomodoroConfig>({
  currentEffectFile: glassFile,
  soundEffect: new Audio(glassFile),
  intervalHandle: undefined,
  durations: { task: 1500, short: 300, long: 1200 },
  phase: { type: 'task', elapsed: 0 },
  counter: { task: 0, short: 0, long: 0 },
  colour: { task: '#ff3366', short: '#ddff00', long: '#33ffcc' }
})

// Editor commands state (the prop-as-event bus; see component-contracts.ts)
const editorCommands = ref<EditorCommands>({
  jumpToLine: false,
  moveSection: false,
  addKeywords: false,
  replaceSelection: false,
  insertPandoc: false,
  executeCommand: false,
  beginAnnotationReattach: false,
  setLanguageToolLanguage: false,
  data: undefined
})

const sidebarsBeforeDistractionfree = ref<{ fileManager: boolean, sidebar: boolean }>({
  fileManager: true,
  sidebar: false
})

const sidebarVisible = computed<boolean>(() => configStore.config.window.sidebarVisible)
const activeFile = computed(() => documentTreeStore.lastLeafActiveFile)
const windowTitle = computed<string>(() => {
  if (activeFile.value === undefined) {
    return 'Zettlr'
  }

  return `Zettlr - ${getDocumentTitle(activeFile.value)}`
})

// Simple state machine to trigger which of the three shows up when. Below's the
// corresponding truth table, which is relatively large, but by spotting some
// patterns, we can see when which of the three Window Chrome elements shall be
// shown.
/*

| Platform | Hide Toolbar in DF? | Is DF? | Is FS? | Titlebar | Menubar | Toolbar |
|----------|---------------------|--------|--------|----------|---------|---------|
| Linux    | False               | False  | False  | False    | !native | True    |
| Linux    | False               | False  | True   | False    | !native | True    |
| Linux    | False               | True   | False  | False    | !native | True    |
| Linux    | False               | True   | True   | False    | !native | True    |
| Linux    | True                | False  | False  | False    | !native | True    |
| Linux    | True                | False  | True   | False    | !native | True    |
| Linux    | True                | True   | False  | False    | !native | False   |
| Linux    | True                | True   | True   | False    | !native | False   |
| macOS    | False               | False  | False  | False    | False   | True    |
| macOS    | False               | False  | True   | False    | False   | True    |
| macOS    | False               | True   | False  | False    | False   | True    |
| macOS    | False               | True   | True   | False    | False   | True    |
| macOS    | True                | False  | False  | False    | False   | True    |
| macOS    | True                | False  | True   | False    | False   | True    |
| macOS    | True                | True   | False  | True     | False   | False   |
| macOS    | True                | True   | True   | False    | False   | False   |
| Windows  | False               | False  | False  | False    | True    | True    |
| Windows  | False               | False  | True   | False    | True    | True    |
| Windows  | False               | True   | False  | False    | True    | True    |
| Windows  | False               | True   | True   | False    | True    | True    |
| Windows  | True                | False  | False  | False    | True    | True    |
| Windows  | True                | False  | True   | False    | True    | True    |
| Windows  | True                | True   | False  | False    | True    | False   |
| Windows  | True                | True   | True   | False    | True    | False   |

*/

// With no toolbar row to drag the window by, macOS keeps its titlebar.
const shouldShowTitlebar = computed<boolean>(() => process.platform === 'darwin')

// The document tab row of the top-right pane is the window's header row.
provide(HEADER_LEAF_ID, computed(() => headerLeafId(paneConfiguration.value)))
// The menubar is independent of other values; always shown on Windows, and on Linux only if native Appearance is off.
const shouldShowMenubar = computed<boolean>(() => process.platform === 'win32' || (process.platform !== 'darwin' && !configStore.config.window.nativeAppearance))





/** The surface NavigationSidebar.vue exposes to its template ref. */
interface NavigationSidebarHandle {
  reveal: (target: RevealTarget) => Promise<void>
  startSearch: (terms: string) => Promise<void>
}

const navigationSidebar = ref<NavigationSidebarHandle|null>(null)
const paneConfiguration = computed(() => documentTreeStore.paneStructure)
const lastLeafId = computed(() => documentTreeStore.lastLeafId)
const distractionFree = computed<boolean>(() => windowStateStore.distractionFreeMode !== undefined)

// Per-pane session history position (issue #1 Phase 5): feeds the toolbar
// Back/Forward controls' enabled state. Refreshed from the documents
// provider whenever the focused leaf or its documents change.
const canGoBack = ref(false)
const canGoForward = ref(false)

/**
 * Asks the documents provider to move the focused pane one step through its
 * session history. Without a focused pane there is no history to move in.
 *
 * @param   {'navigate-back'|'navigate-forward'}  command  The direction
 */
function navigateHistory (command: 'navigate-back'|'navigate-forward'): void {
  const leafId = lastLeafId.value
  if (leafId === undefined) {
    return // No pane has been focused yet; there is no history to navigate
  }

  ipcRenderer.invoke('documents-provider', {
    command,
    payload: { windowId, leafId }
  }).catch(err => console.error(err))
}

function refreshNavigationState (): void {
  const leafId = lastLeafId.value
  if (leafId === undefined) {
    canGoBack.value = false
    canGoForward.value = false
    return
  }

  ipcRenderer.invoke('documents-provider', {
    command: 'get-navigation-state',
    payload: { windowId, leafId }
  })
    .then(state => {
      canGoBack.value = state.canGoBack
      canGoForward.value = state.canGoForward
    })
    .catch(err => console.error(err))
}

watch(lastLeafId, refreshNavigationState)
ipcRenderer.on('documents-update', () => { refreshNavigationState() })
refreshNavigationState()

// Showing a pane ends distraction-free mode; the panes themselves mount
// and unmount with their config values.
watch([ sidebarVisible, fileManagerVisible ], ([ panel, sidebar ]) => {
  if ((panel || sidebar) && windowStateStore.distractionFreeMode !== undefined) {
    windowStateStore.distractionFreeMode = undefined
  }
})

watch(distractionFree, (newValue) => {
  if (newValue) {
    // Enter distraction free mode
    sidebarsBeforeDistractionfree.value = {
      fileManager: fileManagerVisible.value,
      sidebar: sidebarVisible.value
    }
    configStore.setConfigValue('window.sidebarVisible', false)
    configStore.setConfigValue('window.fileManagerVisible', false)
  } else {
    // Leave distraction free mode
    configStore.setConfigValue('window.sidebarVisible', sidebarsBeforeDistractionfree.value.sidebar)
    configStore.setConfigValue('window.fileManagerVisible', sidebarsBeforeDistractionfree.value.fileManager)
  }
})

onMounted(() => {
  // Saves that main initiated — the close-and-save prompts — have no renderer
  // promise to carry their result, so the provider broadcasts refusals here.
  // Without this the prompt closes and the window stays open with no reason
  // given anywhere the user can see.
  ipcRenderer.on(SAVE_REFUSED_CHANNEL, (event, payload: SaveRefusedBroadcast) => {
    const name = pathBasename(payload.filePath)
    const message = payload.refusal === undefined
      ? trans('Could not save "%s".', name)
      : `${name}: ${payload.refusal.message}`
    showToast(message, 'error', 12000)
  })

  // The window-level shortcuts this component owns, by their typed name. The
  // main process sends the same names from the application menu; names other
  // components own (save-file, search, …) have no entry here.
  const shortcutHandlers: Partial<Record<ShortcutName, () => void>> = {
    'toggle-annotation-panel': () => {
      configStore.setConfigValue('window.sidebarVisible', !sidebarVisible.value)
    },
    'insert-id': () => {
      editorCommands.value.data = generateId(configStore.config.zkn.idGen)
      editorCommands.value.replaceSelection = !editorCommands.value.replaceSelection
    },
    'copy-current-id': () => {
      if (documentTreeStore.lastLeafActiveFile === undefined) {
        return
      }
      ipcRenderer.invoke('fsal', {
        command: 'get-descriptor',
        payload: documentTreeStore.lastLeafActiveFile.path
      })
        .then((descriptor: AnyDescriptor|AnyDescriptor[]|undefined) => {
          if (descriptor !== undefined && !Array.isArray(descriptor) && descriptor.type === 'file' && descriptor.id !== '') {
            navigator.clipboard.writeText(descriptor.id).catch(err => console.error(err))
          }
        })
        .catch(err => console.error(err))
    },
    'global-search': () => navigationSidebar.value?.reveal({ module: 'search', focus: 'search-query' }),
    'toggle-navigation-sidebar': () => {
      configStore.setConfigValue('window.fileManagerVisible', !fileManagerVisible.value)
    },
    // The file manager focuses its own filter on the next tick; the sidebar
    // and the Project module only have to be visible by then.
    'filter-files': () => navigationSidebar.value?.reveal({ module: 'project', focus: 'none' }),
    export: () => openExport(),
    'pandoc-quick-help': () => { showPandocQuickHelp.value = true },
    print: () => {
      if (activeFile.value !== undefined) {
        ipcRenderer.invoke('application', { command: 'print', payload: activeFile.value.path })
          .catch(err => console.error(err))
      }
    },
    'navigate-back': () => { navigateHistory('navigate-back') },
    'navigate-forward': () => { navigateHistory('navigate-forward') },
    'insert-pandoc-div': () => { insertPandoc({ type: 'div', attributes: '' }) },
    'insert-pandoc-span': () => { insertPandoc({ type: 'span', attributes: '' }) },
    'open-command-launcher': () => openReferenceSearch(null)
  }

  ipcRenderer.on('shortcut', (event, shortcut: unknown, payload: unknown) => {
    if (typeof shortcut !== 'string' || !isShortcutName(shortcut)) {
      throw new Error(`The main process sent an unknown shortcut: ${String(shortcut)}`)
    }
    if (shortcut === 'insert-table') {
      insertTable(insertTablePayloadSchema.parse(payload))
      return
    }
    if (isEditorCommandName(shortcut)) {
      runEditorCommand(shortcut)
      return
    }
    shortcutHandlers[shortcut]?.()
  })

  // Check if there is an update available.
  ipcRenderer.invoke('update-provider', { command: 'update-status' })
    .then(state => {
      isUpdateAvailable.value = state.updateAvailable
    })
    .catch(err => console.error(err))

  // Also, listen for any changes in the update available state
  ipcRenderer.on('update-provider', (event, command: string, updateState: UpdateState) => {
    if (command === 'state-changed') {
      isUpdateAvailable.value = updateState.updateAvailable
    }
  })
})

function insertTable (spec: { rows: number, cols: number }): void {
  // Generate a simple table based on the info, and insert it.
  const align = new Array<'center'|'left'|'right'|null>(spec.cols).fill(null)
  const row = (): string[] => new Array<string>(spec.cols).fill('')
  const ast: string[][] = Array.from({ length: spec.rows }, row)

  editorCommands.value.data = buildPipeMarkdownTable(ast, align)
  editorCommands.value.replaceSelection = !editorCommands.value.replaceSelection
}

function insertPandoc (spec: { type: string, attributes: string }): void {
  editorCommands.value.data = spec
  editorCommands.value.insertPandoc = !editorCommands.value.insertPandoc
}

function genericJtl (lineNumber: number): void {
  // This function is called from the sidebar where we already know the file
  // is open (because its editor component has provided the table of
  // contents in the first place).
  const doc = documentTreeStore.lastLeafActiveFile
  if (doc !== undefined) {
    editorCommands.value.data = { filePath: doc.path, lineNumber }
    editorCommands.value.jumpToLine = !editorCommands.value.jumpToLine
  }
}

function jtl (filePath: string, lineNumber: number, newTab: boolean): void {
  // We need to make sure the given file is (a) open somewhere and (b) the
  // active file.

  // Simplest case: The file is already active somewhere
  const activeFileLeaf = documentTreeStore.paneData
    .find((pane: LeafNodeJSON) => pane.activeFile?.path === filePath)
  if (activeFileLeaf !== undefined) {
    // There is at least one leaf with the given file being active, so we
    // can simply emit the event
    editorCommands.value.data = { filePath, lineNumber }
    editorCommands.value.jumpToLine = !editorCommands.value.jumpToLine
    return
  }

  const WAIT_TIME = 100 // How long to wait before re-executing the jtl()

  // Next, let's see if the file is at least open somewhere
  const containingLeaf = documentTreeStore.paneData
    .find((pane: LeafNodeJSON) => {
      return pane.openFiles.find(doc => doc.path === filePath) !== undefined
    })
  if (containingLeaf !== undefined) {
    // Let's first make it the active file and then execute the command
    ipcRenderer.invoke('documents-provider', {
      command: 'open-file',
      payload: { path: filePath, windowId, leafId: containingLeaf.id }
    })
      .then(() => {
        // Re-execute the jtl command
        setTimeout(() => jtl(filePath, lineNumber, newTab), WAIT_TIME)
      })
      .catch(e => console.error(e))
    return
  }

  // If we're here, the file was not open, so we have to do that first. At
  // least this both makes it an open file AND an active file somewhere in
  // the window.
  ipcRenderer.invoke('documents-provider', {
    command: 'open-file',
    payload: {
      path: filePath,
      windowId,
      leafId: lastLeafId.value,
      newTab
    }
  })
    .then(() => {
      // Re-execute the jtl command
      setTimeout(() => jtl(filePath, lineNumber, newTab), WAIT_TIME)
    })
    .catch(e => console.error(e))
}

/**
 * S8/I6: forwards the panel's Reattach intent (an annotation id — never a
 * range the panel guessed) to the last focused editor pane for the active
 * document. The pane itself decides whether the owner's current selection
 * is a usable replacement range (component-contracts.ts EditorCommands).
 *
 * @param   {string}  annotationId  The orphaned annotation to reattach
 */
function beginAnnotationReattach (annotationId: string): void {
  const doc = documentTreeStore.lastLeafActiveFile
  if (doc === undefined) {
    return
  }
  editorCommands.value.data = { filePath: doc.path, annotationId }
  editorCommands.value.beginAnnotationReattach = !editorCommands.value.beginAnnotationReattach
}

function moveSection (data: { from: number, to: number }): void {
  editorCommands.value.data = { from: data.from, to: data.to }
  editorCommands.value.moveSection = !editorCommands.value.moveSection
}

async function startGlobalSearch (terms: string): Promise<void> {
  await navigationSidebar.value?.startSearch(terms)
}


function setPomodoroConfig (config: PomodoroConfig): void {
  // Update the durations as necessary
  pomodoro.value.durations.task = config.durations.task
  pomodoro.value.durations.short = config.durations.short
  pomodoro.value.durations.long = config.durations.long

  const effectChanged = config.currentEffectFile !== pomodoro.value.currentEffectFile
  const volumeChanged = config.soundEffect.volume !== pomodoro.value.soundEffect.volume
  if (effectChanged) {
    pomodoro.value.currentEffectFile = config.currentEffectFile
    pomodoro.value.soundEffect = new Audio(config.currentEffectFile)
    pomodoro.value.soundEffect.volume = config.soundEffect.volume
  }
  if (!effectChanged && volumeChanged) {
    pomodoro.value.soundEffect.volume = config.soundEffect.volume
  }

  if (effectChanged || volumeChanged) {
    pomodoro.value.soundEffect.pause()
    pomodoro.value.soundEffect.currentTime = 0
    pomodoro.value.soundEffect.play().catch(_e => {
      /* We will be getting errors when pausing quickly */
    })
  }
}


function startPomodoro (): void {
  pomodoro.value.soundEffect.pause()
  pomodoro.value.soundEffect.currentTime = 0
  // Starts a new pomodoro timer
  pomodoro.value.phase.type = 'task'
  pomodoro.value.phase.elapsed = 0

  pomodoro.value.intervalHandle = setInterval(() => {
    pomodoroTick()
  }, 1000)
}

function pomodoroTick (): void {
  // Progresses the pomodoro counter by one second
  pomodoro.value.phase.elapsed += 1

  const currentPhaseDur = pomodoro.value.durations[pomodoro.value.phase.type]
  const phaseIsFinished = pomodoro.value.phase.elapsed === currentPhaseDur

  if (phaseIsFinished) {
    pomodoro.value.phase.elapsed = 0
    pomodoro.value.counter[pomodoro.value.phase.type] += 1

    if (pomodoro.value.phase.type === 'task' && pomodoro.value.counter.task % 4 === 0) {
      pomodoro.value.phase.type = 'long'
    } else if (pomodoro.value.phase.type === 'task') {
      pomodoro.value.phase.type = 'short'
    } else {
      // Both breaks lead to a new task
      pomodoro.value.phase.type = 'task'
    }

    pomodoro.value.soundEffect.play().catch(_e => { /* We will be getting errors when pausing quickly */ })
  }
}

function stopPomodoro (): void {
  pomodoro.value.soundEffect.pause()
  pomodoro.value.soundEffect.currentTime = 0
  // Stops the pomodoro timer
  pomodoro.value.phase.type = 'task'
  pomodoro.value.phase.elapsed = 0
  pomodoro.value.counter.task = 0
  pomodoro.value.counter.short = 0
  pomodoro.value.counter.long = 0

  if (pomodoro.value.intervalHandle !== undefined) {
    clearInterval(pomodoro.value.intervalHandle)
    pomodoro.value.intervalHandle = undefined
  }
}

</script>

<style lang="less">
body {
  .main-panes {
    display: flex;
    height: 100%;
  }

  .main-pane {
    min-width: 0;
    overflow: auto;
  }

  // A hairline with a wider hit area; the accent while hovered or dragged.
  .main-pane-handle {
    position: relative;
    flex: 0 0 auto;
    width: 1px;
    background-color: var(--chrome-border);
    cursor: col-resize;

    &::after {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      left: -4px;
      right: -4px;
    }

    &[data-resize-handle-state="hover"],
    &[data-resize-handle-state="drag"] {
      background-color: var(--chrome-row-accent);
    }
  }
}
</style>
