<template>
  <div
    id="file-tree"
    ref="rootElement"
    role="region"
    aria-label="File Tree"
    :class="{ 'hidden': !isVisible }"
    :aria-hidden="!isVisible"
    @click="clickHandler"
  >
    <template v-if="rootDescriptors.length > 0">
      <div
        v-if="filterQuery.trim() !== '' && filterResults.length === 0"
        class="empty-tree"
      >
        <div class="info">
          {{ noResultsMessage }}
        </div>
      </div>

      <template v-if="getFiles.length > 0">
        <div
          id="directories-files-header"
          :title="showFilesSection ? hideFilesLabel : showFilesLabel"
          @click="configStore.setConfigValue('fileManagerShowFiles', !showFilesSection)"
          @contextmenu="fileRootContextMenu"
        >
          <cds-icon
            role="presentation"
            shape="angle"
            :direction="showFilesSection ? 'down' : 'right'"
          />

          <cds-icon
            v-if="platform !== 'darwin'"
            shape="file"
            role="presentation"
          />

          {{ fileSectionHeading }}

          <cds-icon
            role="presentation"
            shape="ellipsis-horizontal"
            class="root-settings"
            @click.stop="fileRootContextMenu"
          />
        </div>

        <template v-if="showFilesSection">
          <TreeItem
            v-for="item in getFiles"
            :key="item.path"
            :item="item"
            :depth="0"
            :active-item="activeTreeItem?.[0]"
            :filter-results="filterResults"
            :has-duplicate-name="(fileNameCounts.get(item.name) ?? 0) > 1"
            :window-id="props.windowId"
            @toggle-file-list="emit('toggle-file-list')"
          />
        </template>
      </template>

      <template v-if="getDirectories.length > 0">
        <div
          id="directories-dirs-header"
          :title="showWorkspacesSection ? hideWorkspacesLabel : showWorkspacesLabel"
          @click="configStore.setConfigValue('fileManagerShowWorkspaces', !showWorkspacesSection)"
          @contextmenu="workspaceRootContextMenu"
        >
          <cds-icon
            role="presentation"
            shape="angle"
            :direction="showWorkspacesSection ? 'down' : 'right'"
          />

          <cds-icon
            v-if="platform !== 'darwin'"
            shape="tree-view"
            role="presentation"
          />

          {{ workspaceSectionHeading }}

          <cds-icon
            ref="workspacesContextMenuButton"
            role="presentation"
            shape="ellipsis-horizontal"
            class="root-settings"
            @click.stop="workspaceRootContextMenu"
          />
        </div>

        <template v-if="showWorkspacesSection">
          <TreeItem
            v-for="item in getDirectories"
            :key="item.path"
            :item="item"
            :filter-results="filterResults"
            :depth="0"
            :active-item="activeTreeItem?.[0]"
            :has-duplicate-name="(directoryNameCounts.get(item.name) ?? 0) > 1"
            :window-id="props.windowId"
            @toggle-file-list="emit('toggle-file-list')"
          />
        </template>
      </template>
    </template>
    <template v-else>
      <div
        class="empty-tree"
        @click="requestOpenRoot"
      >
        <div class="info">
          {{ noRootsMessage }}
        </div>
      </div>
    </template>
  </div>

  <PopoverWrapper
    v-if="workspacesContextMenuButton !== null && showSortingPopover"
    :target="workspacesContextMenuButton"
    :placement-priorities="[ 'right', 'below' ]"
    @close="showSortingPopover = false"
  >
    <h4>Sort workspaces</h4>
    <p>Drag and drop to sort workspaces manually.</p>
    <ul id="workspaces-drag-list">
      <li
        v-for="ws in getDirectories"
        :key="ws.path"
        :data-path="ws.path"
        draggable="true"
        @dragstart="startDragging"
        @dragover="dragOver"
        @drop="drop"
      >
        <cds-icon shape="bars" />
        {{ ws.name }}
      </li>
    </ul>
    <p v-if="configStore.config.fileManager.sortWorkspacesManually">
      <ButtonControl
        :label="autoSortButtonLabel"
        @click="configStore.setConfigValue('fileManager.sortWorkspacesManually', false)"
      />
    </p>
  </PopoverWrapper>

  <PopoverWrapper
    v-if="workspacesContextMenuButton !== null && showMetadataKeyPopover && metadataDirectory !== undefined"
    :target="workspacesContextMenuButton"
    :placement-priorities="[ 'right', 'below' ]"
    @close="showMetadataKeyPopover = false"
  >
    <div class="explorer-metadata-popover">
      <h4>{{ metadataFieldHeading }}</h4>
      <TextControl
        v-model="metadataKeyDraft"
        name="explorer-metadata-key"
        :label="metadataFieldLabel"
        placeholder="date"
        @confirm="commitMetadataKey"
      />
      <ButtonControl
        :label="applyLabel"
        @click="commitMetadataKey"
      />
    </div>
  </PopoverWrapper>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        FileTree
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Displays the FSAL file tree contents as a tree.
 *
 * END HEADER
 */

import { reportError } from '@common/util/error-reporting'
import { trans } from '@common/i18n-renderer'
import TreeItem from './TreeItem.vue'
import matchQuery from './util/match-query'
import { ref, computed } from 'vue'
import { useConfigStore, useDocumentTreeStore, useWindowStateStore } from 'source/pinia'
import { useWorkspaceStore } from 'source/pinia/workspace-store'
import { retrieveChildrenAndSort } from './util/retrieve-children-and-sort'
import type {
  AnyDescriptor,
  DirectoryExplorerSettings,
  DirectorySettings,
  DirDescriptor,
  FileNameDisplay,
  ProjectFileFilter,
  SortMethod
} from 'source/types/common/fsal'
import type { DocumentManagerIPCAPI } from 'source/app/service-providers/documents'
import { isInsideRoot, pathDirname } from 'source/common/util/renderer-path-polyfill'
import { closeFile, closeWorkspace } from './util/item-composable'
import showPopupMenu, { type AnyMenuItem } from 'source/common/modules/window-register/application-menu-helper'
import type { CloseAllIPCAPI } from 'source/app/service-providers/windows'
import PopoverWrapper from 'source/common/vue/PopoverWrapper.vue'
import ButtonControl from 'source/common/vue/form/elements/ButtonControl.vue'
import TextControl from 'source/common/vue/form/elements/TextControl.vue'
import { filterDescriptorChildren } from './util/filter-children'
import { sortExplorerChildren } from '@common/util/explorer-ordering'
import type { DirSettingsCommandAPI } from 'source/app/service-providers/commands/dir-settings'

type SortChoice = 'display'|'filename'|'title'|'heading'|'modified'|'created'|'manual'|'metadata'|'book'
type Direction = 'up'|'down'
type FoldersMode = 'inherit'|'folders'|'mixed'

const ipcRenderer = window.ipc

const props = defineProps<{
  isVisible: boolean
  filterQuery: string
  filePickerActive: boolean
  filePickerPaths: string[]
  filePickerPathSet: Set<string>
  windowId: string
}>()

const emit = defineEmits<{
  (e: 'selection', event: MouseEvent): void
  (e: 'toggle-file-list'): void
}>()

// Can contain the path to a tree item that is focused
const activeTreeItem = ref<undefined|[string, string]>(undefined)
const rootElement = ref<HTMLDivElement|null>(null)

const workspacesContextMenuButton = ref<HTMLElement|null>(null)
const showSortingPopover = ref(false)
const showMetadataKeyPopover = ref(false)
const metadataDirectoryPath = ref<string|null>(null)
const metadataKeyDraft = ref('date')

const workspaceStore = useWorkspaceStore()
const windowStateStore = useWindowStateStore()
const documentTreeStore = useDocumentTreeStore()
const configStore = useConfigStore()

const rootDescriptors = computed(() => workspaceStore.rootDescriptors)

const showFilesSection = computed(() => configStore.config.fileManagerShowFiles)
const showWorkspacesSection = computed(() => configStore.config.fileManagerShowWorkspaces)
const lastLeafId = computed(() => documentTreeStore.lastLeafId)

const platform = process.platform
const fileSectionHeading = trans('Files')
const workspaceSectionHeading = trans('Workspaces')
const noRootsMessage = trans('No open files or folders')
const noResultsMessage = trans('No results')
const hideFilesLabel = trans('Hide files')
const showFilesLabel = trans('Show files')
const hideWorkspacesLabel = trans('Hide workspaces')
const showWorkspacesLabel = trans('Show workspaces')
const autoSortButtonLabel = trans('Switch to automatic sorting')
const displayAsLabel = trans('Display as')
const sortByLabel = trans('Sort by')
const directionLabel = trans('Direction')
const groupingLabel = trans('Grouping')
const projectFilesLabel = trans('Project files')
const defaultLabel = trans('Default')
const filenameLabel = trans('Filename')
const titleLabel = trans('Title')
const headingLabel = trans('First heading')
const titleHeadingLabel = trans('Title or first heading')
const displayedNameLabel = trans('Displayed name')
const modifiedLabel = trans('Modified')
const createdLabel = trans('Created')
const manualOrderLabel = trans('Manual order (zettlr-order_)')
const metadataFieldMenuLabel = trans('Metadata field…')
const projectOrderLabel = trans('Book / Project order')
const ascendingLabel = trans('Ascending')
const descendingLabel = trans('Descending')
const foldersFirstLabel = trans('Folders first')
const mixedLabel = trans('Mixed')
const allFilesLabel = trans('All')
const includedLabel = trans('Included')
const omittedLabel = trans('Not included')
const metadataFieldHeading = trans('Sort by metadata field')
const metadataFieldLabel = trans('Metadata field')
const applyLabel = trans('Apply')

const useH1 = computed(() => configStore.config.fileNameDisplay.includes('heading'))
const useTitle = computed(() => configStore.config.fileNameDisplay.includes('title'))

const query = computed(() => props.filterQuery.trim().toLowerCase())
const filterActive = computed(() => query.value !== '' || props.filePickerActive)

const activeWorkspace = computed<DirDescriptor|undefined>(() => {
  const roots = getDirectories.value
  const selected = configStore.config.openDirectory
  if (selected !== null) {
    const containing = roots
      .filter(root => selected === root.path || isInsideRoot(selected, root.path))
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (containing !== undefined) {
      return containing
    }
  }
  return roots.length === 1 ? roots[0] : undefined
})

const metadataDirectory = computed<DirDescriptor|undefined>(() => {
  const path = metadataDirectoryPath.value
  if (path === null) return undefined
  const descriptor = workspaceStore.descriptorMap.get(path)
  return descriptor?.type === 'directory' ? descriptor : undefined
})

const filterResults = computed<string[]>(() => {
  const q = query.value
  if (!filterActive.value) {
    return []
  }

  if (props.filePickerActive && q === '') {
    return props.filePickerPaths
  }

  const filter = matchQuery(
    q,
    useTitle.value,
    useH1.value,
    undefined
  )
  const results: string[] = []

  if (props.filePickerActive) {
    for (const absPath of props.filePickerPaths) {
      const descriptor = workspaceStore.descriptorMap.get(absPath)
      if (descriptor !== undefined && filter(descriptor)) {
        results.push(absPath)
      }
    }
  } else {
    for (const [ absPath, descriptor ] of workspaceStore.descriptorMap.entries()) {
      if (filter(descriptor)) {
        results.push(absPath)
      }
    }
  }

  return results
})

const getFiles = computed(() => {
  // NOTE: These are the root files. We'll only allow Markdown and code files here.
  const roots = rootDescriptors.value.filter(desc => desc.type === 'file' || desc.type === 'code')
  if (!filterActive.value) {
    return roots
  }

  if (props.filePickerActive && query.value === '') {
    return roots.filter(root => props.filePickerPathSet.has(root.path))
  }

  return roots.filter(root => filterResults.value.includes(root.path))
})

const getDirectories = computed(() => {
  const roots = rootDescriptors.value.filter(desc => desc.type === 'directory')
  if (!filterActive.value) {
    return roots
  }

  return roots.filter(root => {
    return filterResults.value.some(res => res.startsWith(root.path))
  })
})

function nameCounts (descriptors: AnyDescriptor[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const descriptor of descriptors) {
    counts.set(descriptor.name, (counts.get(descriptor.name) ?? 0) + 1)
  }
  return counts
}

const fileNameCounts = computed(() => nameCounts(getFiles.value))
const directoryNameCounts = computed(() => nameCounts(getDirectories.value))

const flatSortedAndFilteredVisualFileDescriptors = computed<Array<[string, string]>>(() => {
  // First, get all descriptors.
  const allDescriptors = [...workspaceStore.descriptorMap.values()]
  // Second, filter them if applicable.
    .filter(descriptor => {
      return !filterActive.value ? true : filterResults.value.some(res => res.startsWith(descriptor.path))
    })

  const uncollapsed = windowStateStore.uncollapsedDirectories
  const collapsed = allDescriptors
    .filter(d => d.type === 'directory' && !uncollapsed.includes(d.path))
    .map(d => d.path)

  const visibleDescriptors = allDescriptors
    // Third, remove any file that is within a collapsed directory
    .filter(descriptor => {
      return collapsed.find(absPath => descriptor.dir.startsWith(absPath)) === undefined
    })

  // Fourth, sort them recursively so that the list is the same as what the file
  // tree will see
  const retValue: AnyDescriptor[] = [
    ...getFiles.value
  ]

  const defaults = {
    sortingType: configStore.config.sorting,
    sortFoldersFirst: configStore.config.sortFoldersFirst,
    fileNameDisplay: configStore.config.fileNameDisplay,
    appLang: configStore.config.appLang,
    fileMetaTime: configStore.config.fileMetaTime
  } as const
  const filter = filterDescriptorChildren()

  for (const descriptor of getDirectories.value) {
    retValue.push(...retrieveChildrenAndSort(descriptor, visibleDescriptors, (directory, children) => {
      return sortExplorerChildren(directory, children, defaults, workspaceStore.rootDescriptors)
    }))
  }

  return retValue
    // Filter out any files and folders that should not be displayed such that
    // this "global" list of files and folders corresponds exactly to how they
    // will be displayed to the user. This is especially important for the
    // navigation with the arrow keys.
    .filter(filter)
    .map(descriptor => ([ descriptor.path, descriptor.type ]))
})

/**
 * Called whenever the user clicks on the "No open files or folders"
 * message -- it requests to open a new folder from the main process.
 * @param  {MouseEvent} evt The click event.
 * @return {void}     Does not return.
 */
function requestOpenRoot (event: MouseEvent): void {
  const command = event.shiftKey ? 'root-open-files' : 'root-open-workspaces'

  ipcRenderer.invoke('application', { command })
    .catch(err => reportError(err))
}

// Close all open root files, including open tabs
function closeAllFiles (): void {
  // Ask for confirmation before closing
  ipcRenderer.invoke('close-all', {
    rootType: 'file'
  } as CloseAllIPCAPI).then((confirm: boolean) => {
    if (!confirm) {
      return
    }

    for (const rootFile of getFiles.value) {
      closeFile(rootFile.path)
    }
  }).catch(err => reportError(err))
}

// Context menu for the `Files` header
function fileRootContextMenu (event: MouseEvent): void {
  const template: AnyMenuItem[] = [
    {
      label: trans('Close all files'),
      type: 'normal',
      action () {
        closeAllFiles()
      }
    },
  ]

  showPopupMenu({ x: event.clientX, y: event.clientY }, template)
}

// Close all open workspaces and associated files, including open tabs.
function closeAllWorkspaces (): void {
  // Ask for confirmation before closing
  ipcRenderer.invoke('close-all', {
    rootType: 'workspace'
  } as CloseAllIPCAPI).then((confirm: boolean) => {
    if (!confirm) {
      return
    }

    for (const dir of getDirectories.value) {
      closeWorkspace(dir.path)
    }
  }).catch(err => reportError(err))
}

/**
 * Collapse uncollapse folders. If `collapseRoots` is `true`, also collapse root
 * workspace directories.
 *
 * @param   {boolean}  collapseRoots  If true, collapses everything.
 */
function collapseAll (collapseRoots: boolean): void {
  // Collapse all folders and roots.
  if (collapseRoots) {
    windowStateStore.uncollapsedDirectories.splice(0)
    return
  }

  // Collapse only child folders, leaving roots uncollapsed
  const roots = new Set(rootDescriptors.value.map(r => r.path))

  const uncollapsed = windowStateStore.uncollapsedDirectories
    .filter(path => !roots.has(path))

  for (const filePath of uncollapsed) {
    let idx = windowStateStore.uncollapsedDirectories.indexOf(filePath)
    if (idx > -1) {
      windowStateStore.uncollapsedDirectories.splice(idx, 1)
    }
  }
}

// Context menu for the `Workspaces` header
function workspaceRootContextMenu (event: MouseEvent): void {
  const twoStep = configStore.config.fileManager.twoStepCollapseWorkspaces
  const roots = new Set(rootDescriptors.value.map(r => r.path))
  const onlyRoots = windowStateStore.uncollapsedDirectories
    .every(path => roots.has(path))

  const collapseRoots = !twoStep || onlyRoots
  const workspace = activeWorkspace.value

  const template: AnyMenuItem[] = [
    {
      label: collapseRoots ? trans('Collapse workspaces') : trans('Collapse subfolders'),
      type: 'normal',
      action () { collapseAll(collapseRoots) }
    },
    {
      label: trans('Sort workspaces…'),
      type: 'normal',
      action () { showSortingPopover.value = true }
    },
    ...explorerViewItems(workspace),
    {
      type: 'separator'
    },
    {
      label: trans('Close all workspaces'),
      type: 'normal',
      action () { closeAllWorkspaces() }
    },
  ]

  showPopupMenu({ x: event.clientX, y: event.clientY }, template, clickedID => {
    if (workspace !== undefined) {
      handleExplorerMenuChoice(workspace, clickedID)
    }
  })
}

function sortPrefix (method: SortMethod): string {
  return method.slice(0, method.lastIndexOf('-'))
}

function sortSuffix (method: SortMethod): Direction {
  return method.endsWith('-down') ? 'down' : 'up'
}

function choiceForDirectory (directory: DirDescriptor): SortChoice {
  const prefix = sortPrefix(directory.settings.sorting)
  if (prefix === 'name') return 'display'
  if (prefix === 'time') return configStore.config.fileMetaTime === 'modtime' ? 'modified' : 'created'
  if (prefix === 'modtime') return 'modified'
  if (prefix === 'creationtime') return 'created'
  if (prefix === 'frontmatter') {
    return directory.settings.explorer.sortMetadataKey === 'zettlr-order_' ? 'manual' : 'metadata'
  }
  if (prefix === 'book') return 'book'
  return prefix as SortChoice
}

function directionForDirectory (directory: DirDescriptor): Direction {
  const suffix = sortSuffix(directory.settings.sorting)
  return sortPrefix(directory.settings.sorting) === 'time'
    ? (suffix === 'up' ? 'down' : 'up')
    : suffix
}

function methodFor (choice: SortChoice, direction: Direction): SortMethod {
  const prefix = choice === 'display'
    ? 'name'
    : choice === 'modified'
      ? 'modtime'
      : choice === 'created'
        ? 'creationtime'
        : choice === 'manual' || choice === 'metadata'
          ? 'frontmatter'
          : choice
  return `${prefix}-${direction}` as SortMethod
}

async function updateExplorerDirectory (
  directory: DirDescriptor,
  settingsPatch: Partial<DirectorySettings>,
  explorerPatch: Partial<DirectoryExplorerSettings> = {}
): Promise<void> {
  const previous = JSON.parse(JSON.stringify(directory.settings)) as DirectorySettings
  const nextExplorer = { ...directory.settings.explorer, ...explorerPatch }
  Object.assign(directory.settings, settingsPatch, { explorer: nextExplorer })
  try {
    await ipcRenderer.invoke('application', {
      command: 'set-directory-setting',
      payload: {
        path: directory.path,
        settings: { ...settingsPatch, explorer: nextExplorer }
      } satisfies DirSettingsCommandAPI
    })
  } catch (err) {
    Object.assign(directory.settings, previous)
    reportError('Could not update Explorer settings', err)
  }
}

function setDisplay (directory: DirDescriptor, value: 'inherit'|FileNameDisplay): void {
  void updateExplorerDirectory(directory, {}, { displayName: value })
}

function setSort (directory: DirDescriptor, value: SortChoice): void {
  const explorerPatch: Partial<DirectoryExplorerSettings> = value === 'manual'
    ? { sortMetadataKey: 'zettlr-order_' }
    : {}
  void updateExplorerDirectory(directory, {
    sorting: methodFor(value, directionForDirectory(directory))
  }, explorerPatch)
}

function setDirection (directory: DirDescriptor, value: Direction): void {
  void updateExplorerDirectory(directory, {
    sorting: methodFor(choiceForDirectory(directory), value)
  })
}

function setGrouping (directory: DirDescriptor, value: FoldersMode): void {
  void updateExplorerDirectory(directory, {}, {
    foldersFirst: value === 'inherit' ? null : value === 'folders'
  })
}

function setProjectFilter (directory: DirDescriptor, value: ProjectFileFilter): void {
  void updateExplorerDirectory(directory, {}, { projectFilter: value })
}

function openMetadataFieldEditor (directory: DirDescriptor): void {
  setSort(directory, 'metadata')
  metadataDirectoryPath.value = directory.path
  metadataKeyDraft.value = directory.settings.explorer.sortMetadataKey || 'date'
  showMetadataKeyPopover.value = true
}

function commitMetadataKey (): void {
  const directory = metadataDirectory.value
  if (directory === undefined) return
  const key = metadataKeyDraft.value.trim()
  if (key === '') return
  void updateExplorerDirectory(directory, {
    sorting: methodFor('metadata', directionForDirectory(directory))
  }, { sortMetadataKey: key })
  showMetadataKeyPopover.value = false
}

function radioItem (id: string, label: string, checked: boolean): AnyMenuItem {
  return { id, label, type: 'radio', checked }
}

function handleExplorerMenuChoice (directory: DirDescriptor, clickedID: string): void {
  switch (clickedID) {
    case 'explorer-display-inherit': setDisplay(directory, 'inherit'); break
    case 'explorer-display-filename': setDisplay(directory, 'filename'); break
    case 'explorer-display-title': setDisplay(directory, 'title'); break
    case 'explorer-display-heading': setDisplay(directory, 'heading'); break
    case 'explorer-display-title-heading': setDisplay(directory, 'title+heading'); break
    case 'explorer-sort-display': setSort(directory, 'display'); break
    case 'explorer-sort-filename': setSort(directory, 'filename'); break
    case 'explorer-sort-title': setSort(directory, 'title'); break
    case 'explorer-sort-heading': setSort(directory, 'heading'); break
    case 'explorer-sort-modified': setSort(directory, 'modified'); break
    case 'explorer-sort-created': setSort(directory, 'created'); break
    case 'explorer-sort-manual': setSort(directory, 'manual'); break
    case 'explorer-sort-metadata': openMetadataFieldEditor(directory); break
    case 'explorer-sort-project': setSort(directory, 'book'); break
    case 'explorer-direction-up': setDirection(directory, 'up'); break
    case 'explorer-direction-down': setDirection(directory, 'down'); break
    case 'explorer-grouping-inherit': setGrouping(directory, 'inherit'); break
    case 'explorer-grouping-folders': setGrouping(directory, 'folders'); break
    case 'explorer-grouping-mixed': setGrouping(directory, 'mixed'); break
    case 'explorer-project-all': setProjectFilter(directory, 'all'); break
    case 'explorer-project-included': setProjectFilter(directory, 'included'); break
    case 'explorer-project-omitted': setProjectFilter(directory, 'omitted'); break
  }
}

function explorerViewItems (directory: DirDescriptor|undefined): AnyMenuItem[] {
  if (directory === undefined) {
    return [
      { type: 'separator' },
      { id: 'explorer-display', label: displayAsLabel, type: 'submenu', enabled: false, submenu: [] },
      { id: 'explorer-sort', label: sortByLabel, type: 'submenu', enabled: false, submenu: [] },
      { id: 'explorer-direction', label: directionLabel, type: 'submenu', enabled: false, submenu: [] },
      { id: 'explorer-grouping', label: groupingLabel, type: 'submenu', enabled: false, submenu: [] }
    ]
  }

  const sortChoice = choiceForDirectory(directory)
  const direction = directionForDirectory(directory)
  const display = directory.settings.explorer.displayName
  const folders = directory.settings.explorer.foldersFirst === null
    ? 'inherit'
    : directory.settings.explorer.foldersFirst ? 'folders' : 'mixed'
  const filter = directory.settings.explorer.projectFilter
  const project = directory.settings.project

  const items: AnyMenuItem[] = [
    { type: 'separator' },
    {
      id: 'explorer-display',
      label: displayAsLabel,
      type: 'submenu',
      submenu: [
        radioItem('explorer-display-inherit', defaultLabel, display === 'inherit'),
        radioItem('explorer-display-filename', filenameLabel, display === 'filename'),
        radioItem('explorer-display-title', titleLabel, display === 'title'),
        radioItem('explorer-display-heading', headingLabel, display === 'heading'),
        radioItem('explorer-display-title-heading', titleHeadingLabel, display === 'title+heading')
      ]
    },
    {
      id: 'explorer-sort',
      label: sortByLabel,
      type: 'submenu',
      submenu: [
        radioItem('explorer-sort-display', displayedNameLabel, sortChoice === 'display'),
        radioItem('explorer-sort-filename', filenameLabel, sortChoice === 'filename'),
        radioItem('explorer-sort-title', titleLabel, sortChoice === 'title'),
        radioItem('explorer-sort-heading', headingLabel, sortChoice === 'heading'),
        radioItem('explorer-sort-modified', modifiedLabel, sortChoice === 'modified'),
        radioItem('explorer-sort-created', createdLabel, sortChoice === 'created'),
        radioItem('explorer-sort-manual', manualOrderLabel, sortChoice === 'manual'),
        {
          id: 'explorer-sort-metadata',
          label: metadataFieldMenuLabel,
          type: 'radio',
          checked: sortChoice === 'metadata'
        },
        ...(project === null ? [] : [
          radioItem('explorer-sort-project', projectOrderLabel, sortChoice === 'book')
        ])
      ]
    },
    {
      id: 'explorer-direction',
      label: directionLabel,
      type: 'submenu',
      submenu: [
        radioItem('explorer-direction-up', ascendingLabel, direction === 'up'),
        radioItem('explorer-direction-down', descendingLabel, direction === 'down')
      ]
    },
    {
      id: 'explorer-grouping',
      label: groupingLabel,
      type: 'submenu',
      enabled: sortChoice !== 'book',
      submenu: [
        radioItem('explorer-grouping-inherit', defaultLabel, folders === 'inherit'),
        radioItem('explorer-grouping-folders', foldersFirstLabel, folders === 'folders'),
        radioItem('explorer-grouping-mixed', mixedLabel, folders === 'mixed')
      ]
    }
  ]

  if (project !== null) {
    items.push({
      id: 'explorer-project-files',
      label: project.manifest.kind === 'quarto' ? trans('Book files') : projectFilesLabel,
      type: 'submenu',
      submenu: [
        radioItem('explorer-project-all', allFilesLabel, filter === 'all'),
        radioItem('explorer-project-included', includedLabel, filter === 'included'),
        radioItem('explorer-project-omitted', omittedLabel, filter === 'omitted')
      ]
    })
  }

  return items
}

function clickHandler (event: MouseEvent): void {
  // We need to bubble this event upwards so that the file manager is informed of the selection
  emit('selection', event)
}

function navigate (event: KeyboardEvent): void {
  // The user requested to navigate into the file tree with the keyboard
  // Only capture arrow movements
  if (![ 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape' ].includes(event.key)) {
    return
  }

  event.stopPropagation()
  event.preventDefault()

  if (event.key === 'Escape') {
    activeTreeItem.value = undefined
    return
  }

  if (flatSortedAndFilteredVisualFileDescriptors.value.length === 0) {
    return // Nothing to navigate
  }

  if (event.key === 'Enter' && activeTreeItem.value !== undefined) {
    // Open the currently active item
    if (activeTreeItem.value[0] === 'directory') {
      configStore.setConfigValue('openDirectory', activeTreeItem.value[0])
    } else {
      // Select the active file (if there is one)
      ipcRenderer.invoke('documents-provider', {
        command: 'open-file',
        payload: {
          path: activeTreeItem.value[0],
          windowId: props.windowId,
          leafId: lastLeafId.value,
          newTab: false
        }
      } as DocumentManagerIPCAPI)
        .catch(e => reportError(e))
    }
  }

  // Get the current index of the current active file
  let currentIndex = flatSortedAndFilteredVisualFileDescriptors.value.findIndex(val => val[0] === activeTreeItem.value?.[0])

  switch (event.key) {
    case 'ArrowDown':
      currentIndex++
      break
    case 'ArrowUp':
      currentIndex--
      break
    case 'ArrowLeft':
      // Close a directory if applicable
      if (currentIndex > -1 && flatSortedAndFilteredVisualFileDescriptors.value[currentIndex][1] === 'directory') {
        const path = flatSortedAndFilteredVisualFileDescriptors.value[currentIndex][0]
        const idx = windowStateStore.uncollapsedDirectories.indexOf(path)
        if (idx > -1) {
          windowStateStore.uncollapsedDirectories.splice(idx, 1)
        }
        return // No need to update activeTreeItem
      } else if (currentIndex > -1 && flatSortedAndFilteredVisualFileDescriptors.value[currentIndex][1] !== 'directory') {
        const path = pathDirname(flatSortedAndFilteredVisualFileDescriptors.value[currentIndex][0])
        const idx = windowStateStore.uncollapsedDirectories.indexOf(path)
        if (idx > -1) {
          windowStateStore.uncollapsedDirectories.splice(idx, 1)
          // Also, here, reset the index to the containing directory. If that was not found, currentIndex is -1
          // meaning navigation stops.
          currentIndex = flatSortedAndFilteredVisualFileDescriptors.value.findIndex(x => x[0] === path)
        }
      }
      break
    case 'ArrowRight':
      // Open a directory if applicable
      if (currentIndex > -1 && flatSortedAndFilteredVisualFileDescriptors.value[currentIndex][1] === 'directory') {
        const path = flatSortedAndFilteredVisualFileDescriptors.value[currentIndex][0]
        if (!windowStateStore.uncollapsedDirectories.includes(path)) {
          windowStateStore.uncollapsedDirectories.push(path)
        }
      }
      return // No need to update activeTreeItem
  }

  // Sanitize the index
  if (currentIndex > flatSortedAndFilteredVisualFileDescriptors.value.length - 1) {
    currentIndex = flatSortedAndFilteredVisualFileDescriptors.value.length - 1
  } else if (currentIndex < 0) {
    currentIndex = 0
  }

  // Set the active tree item
  activeTreeItem.value = flatSortedAndFilteredVisualFileDescriptors.value[currentIndex]
  windowStateStore.desktopFocusPath = activeTreeItem.value[0]
}

function stopNavigate (): void {
  activeTreeItem.value = undefined
}

function getRootElement (): HTMLDivElement|null {
  return rootElement.value
}

// Dragging for the manual workspaces sort popover
function startDragging (event: DragEvent): void {
  if (event.currentTarget === null || !(event.currentTarget instanceof HTMLLIElement)) {
    return
  }

  const dragPath = event.currentTarget.dataset.path
  if (dragPath !== undefined && event.dataTransfer !== null) {
    event.dataTransfer.dropEffect = 'move'
    event.dataTransfer.setData('x-zettlr/workspaces-drag-source', dragPath)
  }
}

function dragOver (event: DragEvent): void {
  const lis = document.querySelectorAll('ul#workspaces-drag-list li')
  lis.forEach(li => li.classList.remove('drag-over'))

  if (event.target === null || !(event.target instanceof HTMLLIElement)) {
    return
  }

  event.preventDefault()
  event.target.classList.add('drag-over')
}

function drop (event: DragEvent): void {
  const lis = document.querySelectorAll<HTMLLIElement>('ul#workspaces-drag-list li')
  const targetLi = lis.entries().map(([ _idx, li ]) => li).find(li => li.classList.contains('drag-over'))
  lis.forEach(li => li.classList.remove('drag-over'))

  if (
    targetLi === undefined ||
    event.currentTarget === null || event.dataTransfer === null ||
    !(event.currentTarget instanceof HTMLLIElement)
  ) {
    return
  }

  const sourcePath = event.dataTransfer.getData('x-zettlr/workspaces-drag-source')
  const targetPath = targetLi.dataset.path

  if (sourcePath === '' || targetPath === undefined) {
    return
  }

  if (sourcePath === targetPath) {
    return
  }

  // Now we have to perform the sorting. The animation indicates that the source
  // path will be moved BEFORE the target path, and that is how splice works.
  const wsPaths = getDirectories.value.map(ws => ws.path)
  const sourceIdx = wsPaths.findIndex(ws => ws === sourcePath)
  const targetIdx = wsPaths.findIndex(ws => ws === targetPath)

  if (sourceIdx < 0 || targetIdx < 0) {
    return
  }

  wsPaths.splice(sourceIdx, 1)
  wsPaths.splice(targetIdx, 0, sourcePath) // NOTE: Inserts *before* targetIdx

  // Finally, emit a config setting
  ipcRenderer.invoke('application', { command: 'sort-workspaces', payload: wsPaths })
    .catch(e => reportError(e))
}

defineExpose({ navigate, stopNavigate, getRootElement })
</script>

<style lang="less">
// @list-item-height: 20px;
ul#workspaces-drag-list {
  margin: 20px;
  padding-left: 0;

  li {
    font-size: 16px;
    list-style-type: none;
    padding: 4px;
    cursor: move;

    &:not(:last-child) {
      border-bottom: 1px solid var(--grey-6);
    }

    &.drag-over {
      /*
        We need a padding here, not margin, because the element needs to
        "contain" the source for drag to work.
      */
      padding-top: 24px;
    }
  }
}

.explorer-metadata-popover {
  min-width: 260px;
  padding: 10px;

  h4 { margin: 0 0 8px; }
}

body {
  #file-tree {
    position: relative;
    width: 100%;
    height: 100%;
    left: 0%;
    overflow-x: hidden;
    overflow-y: auto;
    outline: none;
    transition: left 0.3s ease, background-color 0.2s ease;

    cds-icon {
      width: 18px;
      height: 18px;
      min-height: 18px;
      min-width: 18px;
    }

    &.hidden { left:-100%; }

    #directories-dirs-header, #directories-files-header {
      display: flex;
      gap: 10px;
      align-items: center;

      cds-icon {
        vertical-align: bottom;
      }

      .root-settings {
        margin-inline-start: auto;
        margin-inline-end: 10px;
        border-radius: 4px;
        padding: 2px;
        width: 22px;
      }
    }

    // The Workspaces bar owns the view/filter menus and therefore stays in
    // reach while the tree beneath it scrolls. Directory rows are separately
    // sticky, so reserve one section-header row above them instead of letting
    // both layers fight for top: 0.
    #directories-dirs-header {
      position: sticky;
      top: 0;
      z-index: 5;
      min-height: var(--chrome-section-height);
      box-sizing: border-box;
      background: var(--chrome-surface);
    }

    .list-item {
      position: relative;
    }

    .empty-tree {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        right: 0;
        text-align: center;
        cursor: pointer; // Indicate that the user can click the area

        .info {
            display: block;
            padding: 10px;
            margin-top: 50%;
            font-weight: bold;
            font-size: 200%;
        }
    }
  }

  &.dark {
    #file-tree {
      #directories-dirs-header, #directories-files-header {
        .close-all {
            background-color: var(--grey-4);
          }
        .close-all:hover {
            background-color: var(--grey-3);
          }
      }
    }
  }
}

body.darwin {
  #file-tree {
    // On macOS, a file-tree will be a sidebar, cf.:
    // https://developer.apple.com/design/human-interface-guidelines/macos/windows-and-views/sidebars/

    #directories-dirs-header, #directories-files-header {
      border: none; // TODO: This comes from a theme
      color: rgb(160, 160, 160);
      font-weight: bold;
      font-size: inherit;
      margin: 20px 0px 5px 10px;

      clr-icon { display: none; }
    }
  }
}

body.win32 {
  #file-tree {
    #directories-dirs-header, #directories-files-header {
      border-bottom: 1px solid rgb(160, 160, 160);
      font-size: 11px;
      padding: 5px 0px 5px 10px;
      margin: 0px 0px 5px 0px;
    }
  }

  &.dark {
    #file-tree {
      background-color: rgb(30, 30, 40);
    }
  }
}

body.linux {
  #file-tree {
    #directories-dirs-header, #directories-files-header {
      border-bottom: 1px solid rgb(160, 160, 160);
      font-size: 11px;
      padding: 5px 0px 5px 10px;
      margin: 0px 0px 5px 0px;
    }
  }

  &.dark {
    #file-tree {
      background-color: rgb(rgb(40, 40, 50));
    }
  }
}
</style>
