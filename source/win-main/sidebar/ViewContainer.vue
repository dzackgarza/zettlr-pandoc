<template>
  <AccordionRoot
    ref="root"
    class="view-container"
    type="multiple"
    v-bind:model-value="expanded"
    v-on:update:model-value="persistExpanded"
  >
    <SplitterGroup
      direction="vertical"
      class="view-container-group"
    >
      <template
        v-for="(section, index) in props.sections"
        v-bind:key="section.id"
      >
        <SplitterResizeHandle
          v-if="index > 0"
          class="view-container-handle"
          v-bind:disabled="!isExpanded(props.sections[index - 1].id) || !isExpanded(section.id)"
          v-on:dragging="dragging = $event"
        ></SplitterResizeHandle>
        <SplitterPanel
          class="view-container-panel"
          v-bind="panelConstraints(isExpanded(section.id))"
          v-bind:collapsible="true"
          v-bind:order="index"
          v-bind:data-section-panel="section.id"
          v-on:collapse="onPanelDragged(section.id, true)"
          v-on:expand="onPanelDragged(section.id, false)"
        >
          <SidebarSection
            v-bind:id="section.id"
            v-bind:label="section.label()"
            v-bind:count="props.counts?.[section.id]"
          >
            <slot v-bind:name="section.id"></slot>
          </SidebarSection>
        </SplitterPanel>
      </template>
      <!-- Takes the room below the headers while every section is collapsed,
           so the collapsed headers stack at the top instead of spreading
           out; an expanded section takes that room itself. -->
      <SplitterPanel
        v-if="!anyExpanded"
        class="view-container-spacer"
        size-unit="%"
        v-bind:min-size="0"
        v-bind:order="props.sections.length"
      ></SplitterPanel>
    </SplitterGroup>
  </AccordionRoot>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ViewContainer
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A sidebar view made of collapsible sections: one accordion
 *                  whose expanded bodies share the drawer's height through a
 *                  vertical splitter and whose collapsed ones take their
 *                  header alone. The collapsed set is config state
 *                  (ui.sidebarCollapsedSections), so it survives a restart;
 *                  the accordion owns the toggle and keyboard behaviour, the
 *                  splitter owns the dragging. Each section's body comes
 *                  through the slot named after it.
 *
 *                  A collapsed section is a pixel-sized panel fixed at the
 *                  header height; an expanded one is a percent-sized panel.
 *                  Toggling a section changes its panel's constraints, and
 *                  the splitter lays the group out again from those
 *                  defaults: collapsed panels at their header, expanded ones
 *                  sharing the rest equally. No section height is persisted.
 *
 * END HEADER
 */

import { AccordionRoot, SplitterGroup, SplitterPanel, SplitterResizeHandle } from 'reka-ui'
import { computed, onMounted, ref } from 'vue'
import SidebarSection from './SidebarSection.vue'
import { collapsedSectionIds, expandedSectionIds, type SidebarSectionDefinition } from './sidebar-views'
import { useConfigStore } from 'source/pinia'
import { isSidebarSectionId, type SidebarSectionId } from '@dts/common/sidebar-views'

const props = defineProps<{
  sections: readonly SidebarSectionDefinition[]
  /** Counts shown in section headers, by section. */
  counts?: Partial<Record<SidebarSectionId, number>>
}>()

const configStore = useConfigStore()

interface AccordionRootHandle { $el: HTMLElement }
const root = ref<AccordionRootHandle | null>(null)

const expanded = computed<SidebarSectionId[]>(() => expandedSectionIds(configStore.config.ui.sidebarCollapsedSections))

function isExpanded (id: SidebarSectionId): boolean {
  return expanded.value.includes(id)
}

const anyExpanded = computed(() => props.sections.some(section => isExpanded(section.id)))

function persistExpanded (value: string | string[] | undefined): void {
  const ids = Array.isArray(value) ? value.filter(isSidebarSectionId) : []
  // The accordion reports only this view's sections; the others keep their state.
  const others = configStore.config.ui.sidebarCollapsedSections.filter(id => !props.sections.some(section => section.id === id))
  const own = collapsedSectionIds(ids).filter(id => props.sections.some(section => section.id === id))
  configStore.setConfigValue('ui.sidebarCollapsedSections', [ ...others, ...own ])
}

function setCollapsed (id: SidebarSectionId, collapsed: boolean): void {
  const current = configStore.config.ui.sidebarCollapsedSections
  if (current.includes(id) === collapsed) {
    return
  }
  const next = collapsed ? [ ...current, id ] : current.filter(entry => entry !== id)
  configStore.setConfigValue('ui.sidebarCollapsedSections', next)
}

// The splitter reports a panel's collapse and expand on its initial layout
// and on programmatic resizes too; only a drag on a handle is the user
// collapsing or expanding a section through the splitter.
const dragging = ref(false)

function onPanelDragged (id: SidebarSectionId, collapsed: boolean): void {
  if (!dragging.value) {
    return
  }
  setCollapsed(id, collapsed)
}

/** The one-header height a collapsed section takes, from the chrome tokens. */
const headerHeight = ref(28)

/** An expanded section keeps at least this share of the drawer. */
const EXPANDED_MINIMUM_PERCENT = 8

interface PanelConstraints {
  sizeUnit: 'px' | '%'
  collapsedSize: number
  minSize: number
  defaultSize: number | undefined
}

/**
 * The splitter constraints of a section's panel: fixed at the header height
 * while collapsed, an equal share of the remaining drawer while expanded.
 */
function panelConstraints (expanded: boolean): PanelConstraints {
  if (expanded) {
    return { sizeUnit: '%', collapsedSize: 0, minSize: EXPANDED_MINIMUM_PERCENT, defaultSize: undefined }
  }
  return { sizeUnit: 'px', collapsedSize: headerHeight.value, minSize: headerHeight.value, defaultSize: headerHeight.value }
}

onMounted(() => {
  const element = root.value?.$el
  if (element === undefined) {
    return
  }
  const declared = Number.parseFloat(getComputedStyle(element).getPropertyValue('--chrome-section-height'))
  if (Number.isFinite(declared) && declared > 0) {
    headerHeight.value = declared
  }
})

defineExpose({ setCollapsed })
</script>

<style lang="less">
.view-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  min-height: 0;

  .view-container-group {
    flex: 1 1 auto;
    min-height: 0;
  }

  .view-container-panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }

  .view-container-handle {
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

  .sidebar-section {
    height: 100%;
  }
}
</style>
