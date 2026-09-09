<template>
  <div
    id="navigation-sidebar"
    v-bind:data-view="view.id"
  >
    <ViewContainer
      v-if="view.id === 'explorer'"
      ref="explorerContainer"
      v-bind:sections="explorerSections"
      v-bind:counts="explorerCounts"
    >
      <template #files>
        <FileManager
          v-bind:window-id="props.windowId"
          v-on:jump-to-line="emit('jump-to-line', $event)"
        ></FileManager>
      </template>
      <template #outline>
        <ToCTab
          v-on:jump-to-line="emit('jump-to-active-line', $event)"
          v-on:move-section="emit('move-section', $event)"
        ></ToCTab>
      </template>
      <template #book>
        <QuartoBookOutline
          v-if="book !== undefined"
          v-bind:root-path="book.path"
          v-bind:navigation="book.navigation"
          v-bind:active-item="activeFilePath"
          v-on:jump="emit('jump-to-line', $event)"
        ></QuartoBookOutline>
      </template>
    </ViewContainer>
    <div
      v-else-if="view.id === 'search'"
      class="sidebar-search-view"
    >
      <GlobalSearch
        ref="globalSearch"
        v-bind:window-id="props.windowId"
        v-on:jtl="(filePath: string, lineNumber: number, newTab: boolean) => emit('jtl', filePath, lineNumber, newTab)"
      ></GlobalSearch>
    </div>
    <ViewContainer
      v-else
      ref="referencesContainer"
      v-bind:sections="referencesSections"
    >
      <template #citations>
        <ReferencesTab></ReferencesTab>
      </template>
      <template #relatedFiles>
        <RelatedFilesTab></RelatedFilesTab>
      </template>
    </ViewContainer>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        NavigationSidebar
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The drawer beside the activity bar (D9): it shows the one
 *                  view the config names (ui.sidebarView) and nothing else.
 *                  The Explorer stacks the file tree with Outline and Book
 *                  as collapsible sections below it; the References view
 *                  stacks the active file's citations with its related
 *                  files; the Search view is the workspace search. Every
 *                  reveal (a shortcut, a menu item, a jump) lands here:
 *                  it opens the drawer, names the view, expands the section
 *                  and focuses what was asked.
 *
 * END HEADER
 */

import { computed, nextTick, ref } from 'vue'
import FileManager from '../file-manager/FileManager.vue'
import GlobalSearch from '../GlobalSearch.vue'
import QuartoBookOutline from '../file-manager/QuartoBookOutline.vue'
import ToCTab from './ToCTab.vue'
import ReferencesTab from './ReferencesTab.vue'
import RelatedFilesTab from './RelatedFilesTab.vue'
import ViewContainer from './ViewContainer.vue'
import { sidebarSection, sidebarView, type RevealTarget } from './sidebar-views'
import { useConfigStore, useDocumentTreeStore, useWindowStateStore, useWorkspaceStore } from 'source/pinia'
import type { SidebarSectionId } from '@dts/common/sidebar-views'
import type { ProjectNavigationItem } from '@dts/common/fsal'

const props = defineProps<{ windowId: string }>()

const emit = defineEmits<{
  /** A jump into a named document (the tree, the book). */
  (e: 'jump-to-line', target: { filePath: string, line: number }): void
  /** A global-search hit: document, line, and whether to open a new tab. */
  (e: 'jtl', filePath: string, lineNumber: number, newTab: boolean): void
  /** A jump within the active document (the outline). */
  (e: 'jump-to-active-line', line: number): void
  (e: 'move-section', data: { from: number, to: number }): void
}>()

const configStore = useConfigStore()
const documentTreeStore = useDocumentTreeStore()
const windowStateStore = useWindowStateStore()
const workspaceStore = useWorkspaceStore()

interface GlobalSearchHandle {
  focusQueryInput: () => void
  startSearch: (overrideQuery?: string) => void
}
interface ViewContainerHandle {
  setCollapsed: (id: SidebarSectionId, collapsed: boolean) => void
}

const globalSearch = ref<GlobalSearchHandle | null>(null)
const explorerContainer = ref<ViewContainerHandle | null>(null)
const referencesContainer = ref<ViewContainerHandle | null>(null)

const view = computed(() => sidebarView(configStore.config.ui.sidebarView))

const activeFilePath = computed(() => documentTreeStore.lastLeafActiveFile?.path)

/** The Quarto project whose root contains the active document, if any. */
const book = computed<{ path: string, navigation: ProjectNavigationItem[] } | undefined>(() => {
  const activePath = activeFilePath.value
  if (activePath === undefined) {
    return undefined
  }
  for (const rootDescriptor of workspaceStore.rootDescriptors) {
    if (rootDescriptor.type !== 'directory' || rootDescriptor.settings.project?.manifest.kind !== 'quarto') {
      continue
    }
    if (activePath.startsWith(rootDescriptor.path)) {
      return { path: rootDescriptor.path, navigation: rootDescriptor.settings.project.manifest.navigation }
    }
  }
  return undefined
})

/** The Explorer's sections; Book only while a Quarto root holds the active file. */
const explorerSections = computed(() => sidebarView('explorer').sections
  .filter(id => id !== 'book' || book.value !== undefined)
  .map(sidebarSection))

const referencesSections = computed(() => sidebarView('references').sections.map(sidebarSection))

const explorerCounts = computed<Partial<Record<SidebarSectionId, number>>>(() => {
  const toc = windowStateStore.tableOfContents
  return toc === undefined ? {} : { outline: toc.length }
})

/** Opens the drawer on the target's view, expands its section, and puts the focus where asked. */
async function reveal (target: RevealTarget): Promise<void> {
  configStore.setConfigValue('ui.sidebarView', target.view)
  configStore.setConfigValue('window.fileManagerVisible', true)
  await nextTick()
  if (target.section !== undefined) {
    const container = target.view === 'explorer' ? explorerContainer.value : referencesContainer.value
    container?.setCollapsed(target.section, false)
  }
  if (target.focus === 'search-query') {
    globalSearch.value?.focusQueryInput()
  }
}

/** Reveals the Search view and runs a search for the given terms. */
async function startSearch (terms: string): Promise<void> {
  await reveal({ view: 'search', focus: 'none' })
  globalSearch.value?.startSearch(terms)
}

defineExpose({ reveal, startSearch })
</script>

<style lang="less">
#navigation-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  min-height: 0;
  color: var(--chrome-text);
  font-size: var(--chrome-font-size);

  .sidebar-search-view {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }
}
</style>
