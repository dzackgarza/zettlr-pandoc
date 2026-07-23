<template>
  <div
    v-if="openFigure !== null"
    class="tikz-lightbox"
    role="dialog"
    aria-label="TikZ figure lightbox"
    v-on:click.self="close"
  >
    <div class="tikz-lightbox-viewer">
      <ImageViewer v-bind:file="openFigure"></ImageViewer>
    </div>
    <button
      class="tikz-lightbox-close"
      aria-label="Close lightbox"
      v-on:click="close"
    >&times;</button>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikzLightbox
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Full-screen lightbox for rendered TikZ figures (issue
 *                  #14). Opens on the editor widget's zettlr-tikz-lightbox
 *                  event carrying the servable SVG path and reuses
 *                  ImageViewer's zoom/pan rather than growing a second zoom
 *                  implementation. Dismissed by Escape and by clicking the
 *                  backdrop.
 *
 * END HEADER
 */

import { onBeforeUnmount, onMounted, ref } from 'vue'
import ImageViewer from './file-viewers/ImageViewer.vue'
import type { OpenDocument } from 'source/types/common/documents'

/**
 * The figure currently on screen, as the document the viewer displays. This is
 * the component's only representation of that fact: null is "no figure is
 * open", and the state carries no shape for "open, but at no location". The
 * viewer is mounted inside the v-if, so it is only ever handed a real figure.
 */
const openFigure = ref<OpenDocument|null>(null)

function close (): void {
  openFigure.value = null
}

function onLightboxRequest (event: Event): void {
  const detail = (event as CustomEvent<{ svgPath: string }>).detail
  if (typeof detail?.svgPath !== 'string') {
    // The request is app-internal: the TikZ figure widget dispatches it with
    // the SVG file the render service wrote. An event on this name carrying
    // anything else means something other than that widget is dispatching it,
    // which is a wiring defect and not a figure this component can decline to
    // show quietly.
    throw new Error(
      'TikzLightbox: a zettlr-tikz-lightbox request arrived without an svgPath string ' +
      `(detail=${JSON.stringify(detail)}). The event is emitted by the TikZ figure widget in ` +
      'source/common/modules/markdown-editor/renderers/render-tikz.ts, which carries the path of ' +
      'the SVG file renderTikz wrote for the clicked figure.'
    )
  }
  openFigure.value = { path: detail.svgPath, pinned: false }
}

function onKeydown (event: KeyboardEvent): void {
  if (event.key === 'Escape' && openFigure.value !== null) {
    event.preventDefault()
    close()
  }
}

onMounted(() => {
  document.addEventListener('zettlr-tikz-lightbox', onLightboxRequest)
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('zettlr-tikz-lightbox', onLightboxRequest)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<style lang="less">
.tikz-lightbox {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.75);
  display: flex;
  align-items: center;
  justify-content: center;

  .tikz-lightbox-viewer {
    width: 92vw;
    height: 92vh;
    background: white;
    border-radius: 6px;
    overflow: hidden;

    .image-viewer-container {
      width: 100%;
      height: 100%;
    }

    // ImageViewer's fit mode caps an image at its natural size, which is the
    // right default for a photograph and useless for a vector diagram a few
    // dozen pixels wide: the lightbox would open showing the figure at
    // exactly the size it already had inline. Scale the figure to the overlay
    // instead, preserving its aspect ratio. This is scoped to the lightbox;
    // the editor pane's viewer keeps its own behaviour, and the moment the
    // user zooms or scrolls the class changes and the rule stops applying.
    .image-wrapper img.fit {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
  }

  .tikz-lightbox-close {
    position: absolute;
    top: 12px;
    right: 16px;
    font-size: 28px;
    line-height: 1;
    background: transparent;
    border: none;
    color: white;
    cursor: pointer;
  }
}

body.dark .tikz-lightbox .tikz-lightbox-viewer {
  background: rgb(43, 43, 44);
}
</style>
