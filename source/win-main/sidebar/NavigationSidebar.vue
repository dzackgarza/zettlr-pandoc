<template>
  <AccordionRoot
    id="navigation-sidebar"
    ref="root"
    type="multiple"
    v-bind:model-value="expanded"
    v-on:update:model-value="persistExpanded"
  >
    <SplitterGroup
      direction="vertical"
      class="navigation-sidebar-group"
    >
      <template
        v-for="(module, index) in visibleModules"
        v-bind:key="module.id"
      >
        <SplitterResizeHandle
          v-if="index > 0"
          class="navigation-sidebar-handle"
          v-bind:disabled="!isExpanded(visibleModules[index - 1].id) || !isExpanded(module.id)"
          v-on:dragging="dragging = $event"
        ></SplitterResizeHandle>
        <SplitterPanel
          v-bind:ref="(panel: unknown) => registerPanel(module.id, panel)"
          class="navigation-sidebar-panel"
          v-bind:collapsible="true"
          v-bind:collapsed-size="collapsedPercent"
          v-bind:min-size="minimumPercent"
          v-bind:order="index"
          v-bind:data-module-panel="module.id"
          v-on:collapse="onPanelDragged(module.id, true)"
          v-on:expand="onPanelDragged(module.id, false)"
        >
          <SidebarModule
            v-bind:id="module.id"
            v-bind:label="module.label()"
            v-bind:count="moduleCount(module.id)"
          >
            <FileManager
              v-if="module.id === 'project'"
              v-bind:window-id="props.windowId"
              v-on:jump-to-line="emit('jump-to-line', $event)"
            ></FileManager>
            <GlobalSearch
              v-else-if="module.id === 'search'"
              ref="globalSearch"
              v-bind:window-id="props.windowId"
              v-on:jtl="(filePath: string, lineNumber: number, newTab: boolean) => emit('jtl', filePath, lineNumber, newTab)"
            ></GlobalSearch>
            <QuartoBookOutline
              v-else-if="module.id === 'book' && book !== undefined"
              v-bind:root-path="book.path"
              v-bind:navigation="book.navigation"
              v-bind:active-item="activeFilePath"
              v-on:jump="emit('jump-to-line', $event)"
            ></QuartoBookOutline>
            <ToCTab
              v-else-if="module.id === 'outline'"
              v-on:jump-to-line="emit('jump-to-active-line', $event)"
              v-on:move-section="emit('move-section', $event)"
            ></ToCTab>
          </SidebarModule>
        </SplitterPanel>
      </template>
    </SplitterGroup>
  </AccordionRoot>
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
 * Description:     The main window's left sidebar: one accordion of stacked
 *                  modules, each hosted by SidebarModule.vue, whose expanded
 *                  bodies share the pane's height through a vertical splitter
 *                  and whose collapsed ones take their header alone. The
 *                  collapsed set is config state (ui.sidebarCollapsedModules),
 *                  so it survives a restart; the accordion owns the toggle and
 *                  keyboard behavior, the splitter owns the dragging.
 *
 * END HEADER
 */

import { AccordionRoot, SplitterGroup, SplitterPanel, SplitterResizeHandle } from 'reka-ui'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import FileManager from '../file-manager/FileManager.vue'
import GlobalSearch from '../GlobalSearch.vue'
import QuartoBookOutline from '../file-manager/QuartoBookOutline.vue'
import ToCTab from './ToCTab.vue'
import SidebarModule from './SidebarModule.vue'
import {
  SIDEBAR_MODULES,
  collapsedModuleIds,
  expandedModuleIds,
  type RevealTarget
} from './sidebar-modules'
import { useConfigStore, useDocumentTreeStore, useWindowStateStore, useWorkspaceStore } from 'source/pinia'
import { isSidebarModuleId, type SidebarModuleId } from '@dts/common/sidebar-modules'
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

interface AccordionRootHandle { $el: HTMLElement }
interface GlobalSearchHandle {
  focusQueryInput: () => void
  startSearch: (overrideQuery?: string) => void
}
interface SplitterPanelHandle {
  collapse: () => void
  expand: () => void
}

const root = ref<AccordionRootHandle | null>(null)
const globalSearch = ref<GlobalSearchHandle | null>(null)
const panels = new Map<SidebarModuleId, SplitterPanelHandle>()

function registerPanel (id: SidebarModuleId, panel: unknown): void {
  if (panel === null || panel === undefined) {
    panels.delete(id)
    return
  }
  if (typeof panel !== 'object' || !('collapse' in panel) || !('expand' in panel)) {
    throw new Error(`The splitter panel of the ${id} module exposes no collapse and expand`)
  }
  panels.set(id, panel as SplitterPanelHandle)
}

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

const visibleModules = computed(() => SIDEBAR_MODULES.filter(module => module.id !== 'book' || book.value !== undefined))

const expanded = computed<SidebarModuleId[]>(() => {
  return expandedModuleIds(configStore.config.ui.sidebarCollapsedModules)
})

function isExpanded (id: SidebarModuleId): boolean {
  return expanded.value.includes(id)
}

function moduleCount (id: SidebarModuleId): number | undefined {
  if (id !== 'outline') {
    return undefined
  }
  const toc = windowStateStore.tableOfContents
  return toc === undefined ? undefined : toc.length
}

function persistExpanded (value: string | string[] | undefined): void {
  const ids = Array.isArray(value) ? value.filter(isSidebarModuleId) : []
  configStore.setConfigValue('ui.sidebarCollapsedModules', collapsedModuleIds(ids))
}

function setCollapsed (id: SidebarModuleId, collapsed: boolean): void {
  const current = configStore.config.ui.sidebarCollapsedModules
  if (current.includes(id) === collapsed) {
    return
  }
  const next = collapsed ? [ ...current, id ] : current.filter(entry => entry !== id)
  configStore.setConfigValue('ui.sidebarCollapsedModules', next)
}

// The splitter reports a panel's collapse and expand on its initial layout
// and on programmatic resizes too; only a drag on a handle is the user
// collapsing or expanding a module through the splitter.
const dragging = ref(false)

function onPanelDragged (id: SidebarModuleId, collapsed: boolean): void {
  if (!dragging.value) {
    return
  }
  setCollapsed(id, collapsed)
}

// The splitter sizes panels in percent of the pane, so the one-header height
// a collapsed module takes is measured once per pane resize.
const paneHeight = ref(1)
const headerHeight = ref(28)
const observer = new ResizeObserver(entries => {
  for (const entry of entries) {
    paneHeight.value = Math.max(entry.contentRect.height, 1)
  }
})

const collapsedPercent = computed(() => headerHeight.value / paneHeight.value * 100)
/** An expanded module keeps at least its header and three rows. */
const minimumPercent = computed(() => (headerHeight.value + 90) / paneHeight.value * 100)

onMounted(() => {
  const element = root.value?.$el
  if (element === undefined) {
    return
  }
  const declared = Number.parseFloat(getComputedStyle(element).getPropertyValue('--chrome-section-height'))
  if (Number.isFinite(declared) && declared > 0) {
    headerHeight.value = declared
  }
  observer.observe(element)
  paneHeight.value = Math.max(element.getBoundingClientRect().height, 1)
})

onBeforeUnmount(() => {
  observer.disconnect()
})

// The accordion is the source of truth; the splitter panels follow it.
watch([ expanded, visibleModules ], async () => {
  await nextTick()
  for (const module of visibleModules.value) {
    const panel = panels.get(module.id)
    if (panel === undefined) {
      continue
    }
    if (isExpanded(module.id)) {
      panel.expand()
    } else {
      panel.collapse()
    }
  }
}, { immediate: true })

/** Makes the sidebar visible, expands a module, and puts the focus where asked. */
async function reveal (target: RevealTarget): Promise<void> {
  configStore.setConfigValue('window.fileManagerVisible', true)
  setCollapsed(target.module, false)
  await nextTick()
  if (target.focus === 'search-query') {
    globalSearch.value?.focusQueryInput()
  }
}

/** Reveals the Search module and runs a search for the given terms. */
async function startSearch (terms: string): Promise<void> {
  await reveal({ module: 'search', focus: 'none' })
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

  .navigation-sidebar-group {
    flex: 1 1 auto;
    min-height: 0;
  }

  .navigation-sidebar-panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }

  .navigation-sidebar-handle {
    flex: 0 0 auto;
    height: 1px;
    background-color: var(--chrome-border);

    &[data-resize-handle-state="hover"],
    &[data-resize-handle-state="drag"] {
      background-color: var(--chrome-row-accent);
    }

    &[data-disabled] {
      cursor: default;
    }
  }

  .sidebar-module {
    height: 100%;
  }
}
</style>
