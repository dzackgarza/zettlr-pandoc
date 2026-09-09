<template>
  <AccordionRoot
    id="navigation-sidebar"
    type="multiple"
    v-bind:model-value="expanded"
    v-on:update:model-value="persistExpanded"
  >
    <SidebarModule
      id="project"
      v-bind:label="projectModule.label()"
    >
      <FileManager
        v-bind:window-id="props.windowId"
        v-on:jump-to-line="emit('jump-to-line', $event)"
      ></FileManager>
    </SidebarModule>
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
 *                  modules, each hosted by SidebarModule.vue. The collapsed
 *                  set is config state (ui.sidebarCollapsedModules), so it
 *                  survives a restart; the accordion itself owns the toggle
 *                  and keyboard behavior.
 *
 * END HEADER
 */

import { AccordionRoot } from 'reka-ui'
import { computed } from 'vue'
import FileManager from '../file-manager/FileManager.vue'
import SidebarModule from './SidebarModule.vue'
import { SIDEBAR_MODULES, collapsedModuleIds, expandedModuleIds } from './sidebar-modules'
import { useConfigStore } from 'source/pinia'
import { isSidebarModuleId, type SidebarModuleId } from '@dts/common/sidebar-modules'

const props = defineProps<{ windowId: string }>()
const emit = defineEmits<(event: 'jump-to-line', target: { filePath: string, line: number }) => void>()

const configStore = useConfigStore()

const projectModule = SIDEBAR_MODULES[0]

const expanded = computed<SidebarModuleId[]>(() => {
  return expandedModuleIds(configStore.config.ui.sidebarCollapsedModules)
})

function persistExpanded (value: string | string[] | undefined): void {
  const ids = Array.isArray(value) ? value.filter(isSidebarModuleId) : []
  configStore.setConfigValue('ui.sidebarCollapsedModules', collapsedModuleIds(ids))
}
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
}
</style>
