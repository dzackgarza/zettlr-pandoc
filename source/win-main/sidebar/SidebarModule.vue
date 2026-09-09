<template>
  <AccordionItem
    v-bind:value="props.id"
    class="sidebar-module"
    v-bind:data-module="props.id"
  >
    <SectionHeader
      v-bind:label="props.label"
      v-bind:count="props.count"
    >
      <template
        v-if="slots.actions !== undefined"
        #actions
      >
        <slot name="actions"></slot>
      </template>
    </SectionHeader>
    <AccordionContent class="sidebar-module-body">
      <slot></slot>
    </AccordionContent>
  </AccordionItem>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        SidebarModule
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The one host of a left-sidebar module: an accordion item
 *                  whose header is the shared SectionHeader and whose body is
 *                  the hosted component. No module writes its own header
 *                  markup or header styles.
 *
 * END HEADER
 */

import { AccordionContent, AccordionItem } from 'reka-ui'
import { useSlots } from 'vue'
import SectionHeader from '@common/vue/chrome/SectionHeader.vue'
import type { SidebarModuleId } from '@dts/common/sidebar-modules'

const props = defineProps<{
  id: SidebarModuleId
  label: string
  count?: number
}>()

const slots = useSlots()
</script>

<style lang="less">
.sidebar-module {
  display: flex;
  flex-direction: column;
  min-height: 0;

  &[data-state="open"] {
    flex: 1 1 0;
  }

  .sidebar-module-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }
}
</style>
