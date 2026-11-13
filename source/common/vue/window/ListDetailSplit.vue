<template>
  <SplitterGroup direction="horizontal" class="list-detail-split">
    <SplitterPanel
      ref="listPanel"
      :default-size="LIST_PERCENT"
      :min-size="MINIMUM_PERCENT"
    >
      <div class="list-detail-scroll">
        <slot name="list"></slot>
      </div>
    </SplitterPanel>
    <SplitterResizeHandle class="list-detail-handle" @dblclick="resetList" />
    <SplitterPanel :min-size="MINIMUM_PERCENT">
      <div class="list-detail-scroll">
        <slot name="detail"></slot>
      </div>
    </SplitterPanel>
  </SplitterGroup>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ListDetailSplit
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A list beside a detail pane, with the splitter of the main
 *                  window (reka-ui). The list starts at a fifth of the width,
 *                  neither pane goes below a fifth, and a double-click on the
 *                  handle gives the list a fifth again. Each pane scrolls its
 *                  own content.
 *
 * END HEADER
 */
import { SplitterGroup, SplitterPanel, SplitterResizeHandle } from "reka-ui";
import { ref } from "vue";

/** The share of the width that the list has at the start and after a reset. */
const LIST_PERCENT = 20;
/** The smallest share of the width of each pane. */
const MINIMUM_PERCENT = 20;

const listPanel = ref<InstanceType<typeof SplitterPanel> | null>(null);

function resetList(): void {
  listPanel.value?.resize(LIST_PERCENT);
}
</script>

<style lang="less">
body .list-detail-split {
  height: 100%;

  // A panel of reka-ui has the inline style `overflow: hidden`, so the box
  // inside it scrolls.
  .list-detail-scroll {
    height: 100%;
    overflow: auto;
  }

  .list-detail-handle {
    position: relative;
    flex: 0 0 auto;
    width: 1px;
    background-color: var(--chrome-border);
    cursor: col-resize;

    // The visible line is one pixel; the area that takes the pointer is wider.
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
