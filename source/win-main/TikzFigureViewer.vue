<template>
  <div
    class="tikz-figure-viewer"
    :data-svg-path="svgPath"
  >
    <img
      ref="imageElement"
      class="tikz-figure-viewer-source"
      :src="sourceUri"
      alt="TikZ figure"
    >
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikZ figure viewer
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Thin Viewer.js adapter shared by every interactive TikZ
 *                  preview surface. Viewer.js owns pan/zoom, wheel, pointer,
 *                  touch/pinch, keyboard, toolbar and inline<->full mode.
 *                  This component intentionally contains no second viewer or
 *                  home-grown transform/zoom state.
 *
 * END HEADER
 */

import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Viewer from 'viewerjs'
import 'viewerjs/dist/viewer.css'
import makeValidUri from '@common/util/make-valid-uri'

const props = withDefaults(defineProps<{
  svgPath: string
  showFullscreenButton?: boolean
}>(), {
  showFullscreenButton: true
})


const imageElement = ref<HTMLImageElement|null>(null)
const sourceUri = ref(makeValidUri(props.svgPath))
let viewer: Viewer|null = null
let fitAnimationFrame: number|null = null
let hasInitialFit = false
let sourceRevision = 0
const VIEWER_TRANSITIONS: Viewer.TransitionOptions = {
  view: false,
  zoom: false,
  move: false,
}

interface ViewerTransformSnapshot {
  ratio: number
  centerOffsetX: number
  centerOffsetY: number
}

let pendingTransformRestore: ViewerTransformSnapshot|null = null

async function waitForSourceImage (image: HTMLImageElement): Promise<void> {
  if (image.complete && image.naturalWidth > 0) {
    return
  }

  await new Promise<void>(resolve => {
    const finish = (): void => {
      image.removeEventListener('load', finish)
      image.removeEventListener('error', finish)
      resolve()
    }
    image.addEventListener('load', finish, { once: true })
    image.addEventListener('error', finish, { once: true })
  })
}

// Viewer.js intentionally refuses to enlarge an image past its natural raster
// dimensions when it computes the initial fit. That is appropriate for
// photographs but not for pdf2svg output: a 100px-wide SVG remains razor sharp
// when displayed at 400px, and the whole purpose of this dedicated viewer is to
// make the diagram comfortably inspectable. We therefore keep Viewer.js in
// charge of the transform and ask its public zoomTo() API for a contain fit that
// may exceed 1:1.
const FIT_COVERAGE = 0.88

function fitToAvailableSpace (): void {
  const source = imageElement.value
  if (viewer === null || source === null) {
    return
  }

  const viewerElement = source.parentElement?.querySelector('.zettlr-tikz-viewerjs')
  const canvas = viewerElement?.querySelector('.viewer-canvas')
  const image = canvas?.querySelector('img')
  if (!(canvas instanceof HTMLElement) || !(image instanceof HTMLImageElement)) {
    return
  }

  const canvasRect = canvas.getBoundingClientRect()
  const footer = viewerElement?.querySelector('.viewer-footer')
  const footerHeight = footer instanceof HTMLElement ? footer.getBoundingClientRect().height : 0
  const naturalWidth = image.naturalWidth
  const naturalHeight = image.naturalHeight
  const availableWidth = canvasRect.width
  const availableHeight = Math.max(0, canvasRect.height - footerHeight)

  if (
    naturalWidth <= 0 || naturalHeight <= 0 ||
    availableWidth <= 0 || availableHeight <= 0
  ) {
    return
  }

  const ratio = Math.min(
    availableWidth / naturalWidth,
    availableHeight / naturalHeight
  ) * FIT_COVERAGE

  if (Number.isFinite(ratio) && ratio > 0) {
    viewer.zoomTo(ratio, false)
    hasInitialFit = true
  }
}

function currentViewerTransform (): ViewerTransformSnapshot|null {
  const source = imageElement.value
  if (source === null) {
    return null
  }

  const viewerElement = source.parentElement?.querySelector('.zettlr-tikz-viewerjs')
  const canvas = viewerElement?.querySelector('.viewer-canvas')
  const image = canvas?.querySelector('img')
  if (!(canvas instanceof HTMLElement) || !(image instanceof HTMLImageElement)) {
    return null
  }

  const width = Number.parseFloat(image.style.width)
  const x = Number.parseFloat(image.style.marginLeft)
  const y = Number.parseFloat(image.style.marginTop)
  const height = Number.parseFloat(image.style.height)
  if (
    !Number.isFinite(width) || !Number.isFinite(height) ||
    !Number.isFinite(x) || !Number.isFinite(y) ||
    image.naturalWidth <= 0
  ) {
    return null
  }

  const canvasRect = canvas.getBoundingClientRect()
  const footer = viewerElement?.querySelector('.viewer-footer')
  const footerHeight = footer instanceof HTMLElement ? footer.getBoundingClientRect().height : 0
  const contentHeight = Math.max(0, canvasRect.height - footerHeight)

  return {
    ratio: width / image.naturalWidth,
    centerOffsetX: x + width / 2 - canvasRect.width / 2,
    centerOffsetY: y + height / 2 - contentHeight / 2,
  }
}

function restoreViewerTransform (snapshot: ViewerTransformSnapshot): void {
  const source = imageElement.value
  if (viewer === null || source === null) {
    return
  }

  const viewerElement = source.parentElement?.querySelector('.zettlr-tikz-viewerjs')
  const canvas = viewerElement?.querySelector('.viewer-canvas')
  const image = canvas?.querySelector('img')
  if (!(canvas instanceof HTMLElement) || !(image instanceof HTMLImageElement)) {
    return
  }

  const canvasRect = canvas.getBoundingClientRect()
  const footer = viewerElement?.querySelector('.viewer-footer')
  const footerHeight = footer instanceof HTMLElement ? footer.getBoundingClientRect().height : 0
  const contentHeight = Math.max(0, canvasRect.height - footerHeight)
  const width = image.naturalWidth * snapshot.ratio
  const height = image.naturalHeight * snapshot.ratio
  const x = canvasRect.width / 2 + snapshot.centerOffsetX - width / 2
  const y = contentHeight / 2 + snapshot.centerOffsetY - height / 2

  // These are Viewer.js' own public transform APIs. The wrapper preserves only
  // the user's current view while the SVG source changes; Viewer.js continues
  // to own all zoom/pan mechanics and gesture state.
  viewer.zoomTo(snapshot.ratio, false)
  viewer.moveTo(x, y)
}

function scheduleFit (): void {
  if (fitAnimationFrame !== null) {
    cancelAnimationFrame(fitAnimationFrame)
  }
  fitAnimationFrame = requestAnimationFrame(() => {
    // Viewer.js recalculates its inline/full container dimensions in the same
    // frame as the mode transition. One further frame guarantees zoomTo() sees
    // the settled canvas rather than the previous mode's geometry.
    fitAnimationFrame = requestAnimationFrame(() => {
      fitAnimationFrame = null
      fitToAvailableSpace()
    })
  })
}

defineExpose({ fit: fitToAvailableSpace })

const toolbar: Viewer.ToolbarOptions = {
  zoomIn: true,
  zoomOut: true,
  oneToOne: true,
  // "Reset" means return to the useful contain fit for vector diagrams. 1:1
  // remains available separately through Viewer.js' own oneToOne control.
  reset: { click: () => { scheduleFit() } },
  prev: false,
  play: false,
  next: false,
  rotateLeft: false,
  rotateRight: false,
  flipHorizontal: false,
  flipVertical: false,
}

onMounted(() => {
  const image = imageElement.value
  if (image === null) {
    throw new Error('TikzFigureViewer mounted without its source image element')
  }

  viewer = new Viewer(image, {
    // There is deliberately only one viewer mode in Zettlr. Viewer.js' inline
    // instance owns its own full()/exit() transition, so a sidecar promoted to
    // lightbox is the same viewer node rather than a second modal viewer.
    inline: true,
    button: props.showFullscreenButton,
    navbar: false,
    navigation: false,
    title: false,
    toolbar,
    focus: false,
    keyboard: true,
    loading: true,
    movable: true,
    rotatable: false,
    rotateOnGesture: false,
    rotateOnTouch: false,
    scalable: false,
    slideOnTouch: false,
    slideOnWheel: false,
    toggleOnDblclick: true,
    tooltip: true,
    zoomable: true,
    zoomOnGesture: true,
    zoomOnTouch: true,
    zoomOnWheel: true,
    initialCoverage: 0.9,
    className: 'zettlr-tikz-viewerjs',
    // This is a live vector preview, so transitions between intermediate
    // geometries are visual noise. Viewer.js still owns every transform and
    // gesture, but applies view/zoom/move immediately.
    transition: VIEWER_TRANSITIONS,
    viewed: () => {
      if (pendingTransformRestore !== null) {
        const snapshot = pendingTransformRestore
        pendingTransformRestore = null
        restoreViewerTransform(snapshot)
        return
      }
      if (!hasInitialFit) {
        scheduleFit()
      }
    },
    ready: () => {
      scheduleFit()
    },
  })
})

watch(
  () => props.svgPath,
  async newPath => {
    const revision = ++sourceRevision
    const image = imageElement.value
    if (viewer === null || image === null) {
      sourceUri.value = makeValidUri(newPath)
      return
    }

    // Capture the current visual transform BEFORE replacing the source. This
    // is what makes editing stable: compile success changes image content, not
    // the user's viewport into it.
    if (pendingTransformRestore === null && hasInitialFit) {
      pendingTransformRestore = currentViewerTransform()
    }
    if (pendingTransformRestore === null) {
      // No stable viewport exists yet, so the replacement should perform the
      // one ordinary initial fit rather than preserving Viewer.js' temporary
      // natural-size layout.
      hasInitialFit = false
    }
    sourceUri.value = makeValidUri(newPath)
    await nextTick()
    // Keep Viewer.js' existing canvas on screen while the replacement SVG is
    // loaded invisibly by its source element. Updating only after that load
    // avoids a blank/natural-size frame between compile success and transform
    // restoration. A newer render supersedes this one without disturbing the
    // still-visible viewer.
    await waitForSourceImage(image)
    if (revision !== sourceRevision || viewer === null) {
      return
    }
    viewer.update()
  }
)

onBeforeUnmount(() => {
  if (fitAnimationFrame !== null) {
    cancelAnimationFrame(fitAnimationFrame)
    fitAnimationFrame = null
  }
  viewer?.destroy()
  viewer = null
})
</script>

<style scoped lang="less">
.tikz-figure-viewer {
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.tikz-figure-viewer-source {
  /* Viewer.js clones this source into its own canvas. Never present both. */
  display: none;
}

/*
 * pdf2svg output is black-on-transparent. Keep the existing dark-mode
 * readability rule, but apply it to Viewer.js' one canonical image surface so
 * inline and full mode cannot diverge.
 */
:global(body.dark .zettlr-tikz-viewerjs .viewer-canvas > img) {
  filter: invert(0.85) hue-rotate(180deg);
}
</style>
