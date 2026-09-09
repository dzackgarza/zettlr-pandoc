<template>
  <DialogRoot
    v-bind:open="state.open"
    v-on:update:open="onOpenChange"
  >
    <DialogPortal>
      <DialogOverlay class="command-launcher-backdrop"></DialogOverlay>
      <DialogContent
        class="command-launcher"
        data-command-launcher
        v-bind:aria-label="dialogLabel"
        v-bind:aria-describedby="undefined"
      >
        <DialogTitle class="command-launcher-title">
          {{ dialogLabel }}
        </DialogTitle>
        <template v-if="state.open">
          <ReferenceSearchView
            v-if="state.view.kind === 'references'"
            v-bind:definitions="referenceDefinitions"
            v-bind:occurrences="referenceOccurrences"
            v-bind:initial-request="state.view.request"
            v-bind:project-roots="referenceProjectRoots"
            v-bind:active-document-path="referenceActiveDocumentPath"
            v-on:jump="onReferenceJump"
            v-on:close="close"
            v-on:back="back"
            v-on:open-help="onOpenHelp"
          ></ReferenceSearchView>
          <MenuCommandsView
            v-else
            v-bind:rows="rows"
            v-bind:query="state.query"
            v-bind:breadcrumb="breadcrumb"
            v-on:update:query="setLauncherQuery"
            v-on:run="run"
            v-on:back="back"
            v-on:close="close"
          ></MenuCommandsView>
        </template>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        CommandLauncher
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The Ctrl+P command launcher: a modal dialog over the
 *                  editor whose submenu tree IS the serialised application
 *                  menu, plus three dynamic groups (Go to file, Go to
 *                  heading, Search references). Labels, shortcuts and
 *                  enablement come from the serialised items; a menu leaf
 *                  executes through the menu provider's click-menu-item, the
 *                  dynamic rows through their typed providers. reka-ui's
 *                  Dialog owns the focus trap and the focus return.
 *
 * END HEADER
 */

import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { computed, onBeforeMount, ref } from 'vue'
import { trans } from '@common/i18n-renderer'
import { menuProviderMessageSchema, type SerializedMenuItem } from '@dts/common/serialized-menu'
import type { ProjectRootSpec, ReferenceDefinition, ReferenceOccurrence } from '@dts/common/references'
import type { WorkspaceReferenceState } from 'source/app/service-providers/references/reference-index'
import type { ReferenceSearchRequest } from '@common/modules/markdown-editor/plugins/reference-search-effect'
import { useDocumentTreeStore, useWindowStateStore, useWorkspaceStore } from 'source/pinia'
import { invokeReferenceProviderRecoverably } from '../util/recoverable-reference-errors'
import getDocumentTitle from '../util/get-document-title'
import { relativePath } from '@common/util/renderer-path-polyfill'
import type { ReferenceJumpIntent } from '../component-contracts'
import MenuCommandsView from './MenuCommandsView.vue'
import ReferenceSearchView from './ReferenceSearchView.vue'
import {
  allMenuLeafRows,
  breadcrumbOf,
  menuGroupRows,
  rankRows,
  type DynamicGroupRow,
  type FileRow,
  type HeadingRow,
  type LauncherRow
} from './launcher-rows'
import {
  CLOSED_LAUNCHER,
  closeLauncher,
  drillInto,
  openLauncherAt,
  popLevel,
  setQuery,
  type LauncherState,
  type LauncherView
} from './launcher-state'

const ipcRenderer = window.ipc

const emit = defineEmits<{
  (e: 'open-file', path: string): void
  (e: 'jump-to-line', line: number): void
  (e: 'jump', intent: ReferenceJumpIntent): void
  (e: 'open-help'): void
}>()

const documentTreeStore = useDocumentTreeStore()
const windowStateStore = useWindowStateStore()
const workspaceStore = useWorkspaceStore()

const dialogLabel = trans('Command launcher')

const state = ref<LauncherState>(CLOSED_LAUNCHER)

// The serialised application menu, parsed once at the IPC boundary and
// refreshed whenever the provider rebuilds the menu.
const menu = ref<SerializedMenuItem[]>([])

onBeforeMount(() => {
  ipcRenderer.on('menu-provider', (_event, payload: unknown) => {
    const message = menuProviderMessageSchema.parse(payload)
    if (message.command === 'application-menu') {
      menu.value = message.payload
    }
  })
  ipcRenderer.send('menu-provider', { command: 'get-application-menu' })
})

const DYNAMIC_GROUPS: readonly DynamicGroupRow[] = [
  { kind: 'dynamic-group', id: 'go-to-file', label: trans('Go to file') },
  { kind: 'dynamic-group', id: 'go-to-heading', label: trans('Go to heading') },
  { kind: 'dynamic-group', id: 'search-references', label: trans('Search references') }
]

/** Every workspace document as a row: its title, and its directory relative to the root that holds it. */
const fileRows = computed<FileRow[]>(() => {
  const roots = workspaceStore.rootDescriptors.map(root => root.path)
  const rows: FileRow[] = []
  for (const descriptor of workspaceStore.descriptorMap.values()) {
    if (descriptor.type !== 'file' && descriptor.type !== 'code') {
      continue
    }
    const root = roots.find(rootPath => descriptor.path.startsWith(rootPath))
    const relative = root === undefined ? descriptor.path : relativePath(root, descriptor.path)
    const directory = relative.split('/').slice(0, -1).filter(segment => segment !== '')
    rows.push({ kind: 'file', path: descriptor.path, label: getDocumentTitle(descriptor), breadcrumb: directory })
  }
  return rows
})

/** The active document's headings, in document order. */
const headingRows = computed<HeadingRow[]>(() => {
  const toc = windowStateStore.tableOfContents
  if (toc === undefined) {
    return []
  }
  return toc.map(entry => ({ kind: 'heading', line: entry.line, level: entry.level, label: entry.text }))
})

/** The rows of the current view before the query ranks them. */
function viewRows (view: LauncherView, query: string): LauncherRow[] {
  switch (view.kind) {
    case 'root': {
      const groups = menuGroupRows(menu.value, []).rows
      const leaves = query === '' ? [] : allMenuLeafRows(menu.value).rows
      return [ ...groups, ...DYNAMIC_GROUPS, ...leaves ]
    }
    case 'menu-group':
      return menuGroupRows(menu.value, view.path).rows
    case 'dynamic-group':
      return view.id === 'go-to-file' ? fileRows.value : headingRows.value
    case 'references':
      return []
  }
}

const rows = computed<LauncherRow[]>(() => {
  if (!state.value.open) {
    return []
  }
  return rankRows(viewRows(state.value.view, state.value.query), state.value.query)
})

const breadcrumb = computed<readonly string[]>(() => {
  if (!state.value.open) {
    return []
  }
  const view = state.value.view
  if (view.kind === 'menu-group') {
    return breadcrumbOf(menu.value, view.path)
  }
  if (view.kind === 'dynamic-group') {
    const group = DYNAMIC_GROUPS.find(row => row.id === view.id)
    return group === undefined ? [] : [ group.label ]
  }
  return []
})

// The references view's data: fetched from the reference provider when the
// view opens, the same snapshot the editor's badges read (issues #53, #46).
const referenceDefinitions = ref<ReferenceDefinition[]>([])
const referenceOccurrences = ref<ReferenceOccurrence[]>([])
const referenceProjectRoots = ref<ProjectRootSpec[]>([])
const referenceActiveDocumentPath = ref<string | undefined>(undefined)

/**
 * Every Project root visible in the workspace, projected to the pure
 * ProjectRootSpec shape the ranking consumes.
 */
function collectProjectRoots (): ProjectRootSpec[] {
  const roots: ProjectRootSpec[] = []
  for (const descriptor of workspaceStore.descriptorMap.values()) {
    if (descriptor.type === 'directory' && descriptor.settings.project !== null) {
      roots.push({ rootPath: descriptor.path, files: [...descriptor.settings.project.files] })
    }
  }
  return roots
}

/** Loads the workspace reference snapshot; a failed fetch surfaces its own toast and returns false. */
async function loadReferences (): Promise<boolean> {
  const outcome = await invokeReferenceProviderRecoverably<WorkspaceReferenceState>(
    async (channel, message) => await ipcRenderer.invoke(channel, message),
    { command: 'get-snapshot' },
    trans('Loading workspace references')
  )
  if (outcome.status === 'failed') {
    return false
  }
  referenceDefinitions.value = outcome.value.snapshots.flatMap(snapshot => snapshot.definitions)
  referenceOccurrences.value = outcome.value.snapshots.flatMap(snapshot => snapshot.occurrences)
  referenceProjectRoots.value = collectProjectRoots()
  referenceActiveDocumentPath.value = documentTreeStore.lastLeafActiveFile?.path
  return true
}

/** Opens the launcher on a view: the root, or the references search for a relayed request. */
async function open (view: LauncherView): Promise<void> {
  if (view.kind === 'references' && !(await loadReferences())) {
    return
  }
  state.value = openLauncherAt(view)
}

function close (): void {
  state.value = closeLauncher()
}

function back (): void {
  state.value = popLevel(state.value)
}

function setLauncherQuery (query: string): void {
  state.value = setQuery(state.value, query)
}

function onOpenChange (open: boolean): void {
  if (!open) {
    close()
  }
}

/** Drills into a group row or executes a leaf row. */
async function run (row: LauncherRow): Promise<void> {
  switch (row.kind) {
    case 'menu-group':
      state.value = drillInto(state.value, { kind: 'menu-group', path: row.path })
      return
    case 'dynamic-group':
      if (row.id === 'search-references') {
        if (await loadReferences()) {
          state.value = drillInto(state.value, { kind: 'references', request: null })
        }
        return
      }
      state.value = drillInto(state.value, { kind: 'dynamic-group', id: row.id })
      return
    case 'menu-leaf':
      close()
      ipcRenderer.send('menu-provider', { command: 'click-menu-item', payload: row.id })
      return
    case 'file':
      close()
      emit('open-file', row.path)
      return
    case 'heading':
      close()
      emit('jump-to-line', row.line)
  }
}

function onReferenceJump (intent: ReferenceJumpIntent): void {
  close()
  emit('jump', intent)
}

function onOpenHelp (): void {
  close()
  emit('open-help')
}

defineExpose({ open, close })
</script>

<style lang="less">
.command-launcher-backdrop {
  position: fixed;
  inset: 0;
  z-index: 400;
  background: var(--chrome-overlay);
}

.command-launcher {
  position: fixed;
  z-index: 401;
  top: clamp(24px, 12vh, 120px);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  width: min(640px, calc(100vw - 32px));
  max-height: min(560px, calc(100vh - 48px));
  overflow: hidden;
  box-sizing: border-box;
  color: var(--chrome-text);
  background: var(--chrome-surface);
  border: 1px solid var(--chrome-border);
  border-radius: 12px;
  box-shadow: var(--chrome-elevation);
  font-size: var(--chrome-font-size);

  .command-launcher-title {
    // Read by assistive technology; the launcher's input is its visible title.
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }

  .launcher-view {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .launcher-query-row {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 8px;
    padding: 0 16px;
    border-bottom: 1px solid var(--chrome-border);
  }

  .launcher-breadcrumb {
    flex: 0 0 auto;
    color: var(--chrome-text-muted);
    font-size: var(--chrome-section-font-size);
  }

  // `body … input.…` outweighs the platform input rules in generic.css.
  body & input.launcher-input {
    flex: 1 1 auto;
    box-sizing: border-box;
    min-width: 0;
    margin: 0;
    padding: 13px 0;
    color: inherit;
    background: transparent;
    border: none;
    border-radius: 0;
    font: inherit;
    font-size: 15px;
    outline: none;

    &::placeholder {
      color: var(--chrome-text-muted);
    }
  }

  .launcher-list {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }

  .launcher-viewport {
    padding: 6px 0;
  }

  .launcher-empty {
    padding: 18px 16px;
    color: var(--chrome-text-muted);
    text-align: center;
  }
}
</style>
