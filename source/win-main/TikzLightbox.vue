<template>
  <div
    v-if="svgPath !== null"
    class="tikz-lightbox"
    role="dialog"
    aria-label="TikZ figure lightbox"
    v-on:click.self="close"
  >
    <div class="tikz-lightbox-viewer">
      <ImageViewer v-bind:file="lightboxFile"></ImageViewer>
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

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import ImageViewer from './file-viewers/ImageViewer.vue'
import type { OpenDocument } from 'source/types/common/documents'

const svgPath = ref<string|null>(null)

const lightboxFile = computed<OpenDocument>(() => ({
  path: svgPath.value ?? '',
  pinned: false,
}))

function close (): void {
  svgPath.value = null
}

function onLightboxRequest (event: Event): void {
  const detail = (event as CustomEvent<{ svgPath: string }>).detail
  if (typeof detail?.svgPath === 'string' && detail.svgPath !== '') {
    svgPath.value = detail.svgPath
  }
}

function onKeydown (event: KeyboardEvent): void {
  if (event.key === 'Escape' && svgPath.value !== null) {
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
