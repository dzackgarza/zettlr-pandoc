<template>
  <div
    :class="{
      'document-tablist-wrapper': true,
      'scrollers-active': showScrollers
    }"
  >
    <!-- Left scroller arrow -->
    <div
      v-if="showScrollers"
      class="scroller left"
      @click="scrollLeft()"
    >
      <cds-icon
        shape="angle"
        direction="left"
      />
    </div>
    <!-- Right scroller arrow -->
    <div
      v-if="showScrollers"
      class="scroller right"
      @click="scrollRight()"
    >
      <cds-icon
        shape="angle"
        direction="right"
      />
    </div>

    <div
      ref="container"
      role="tablist"
      :class="{ 'tab-container': true }"
      @contextmenu="handleTabbarContext($event)"
      @dragover="handleExternalDragover"
      @dragend="handleExternalDragleave"
    >
      <div
        v-for="file in openFiles"
        :key="file.path"
        :class="{
          active: activeFile !== null && file.path === activeFile.path,
          modified: modifiedPaths.includes(file.path),
          pinned: file.pinned
        }"
        :title="file.path"
        :aria-label="getAccessibleTabLabel(file)"
        :data-path="file.path"
        :draggable="true"
        role="tab"
        @dragstart="handleDragStart($event, file.path)"
        @drag="handleDrag"
        @dragend="handleDragEnd"
        @contextmenu.stop="handleContextMenu($event, file)"
        @mouseup="handleMiddleMouseClick($event, file)"
        @mousedown="handleClickFilename($event, file)"
      >
        <span
          class="filename"
          role="button"
        >
          <cds-icon
            v-if="file.pinned"
            shape="pin"
          />
          {{ getDocumentTitle(file) }}
        </span>
        <span
          v-if="hasDuplicate(file)"
          class="deduplicate"
        >{{ getDirBasename(file) }}</span>
        <span
          v-if="modifiedPaths.includes(file.path)"
          class="modification-indicator"
          :title="unsavedChangesLabel"
          aria-hidden="true"
        />
        <span
          v-if="!file.pinned"
          class="close"
          aria-hidden="true"
          @mousedown.stop.prevent="handleClickClose($event, file)"
        >&times;</span>
      </div>

      <div
        v-if="documentTabDragOver"
        :class="{
          dropzone: true,
          dragover: true
        }"
        @drop="handleExternalDrop"
        @dragover="handleExternalDragover"
        @dragleave="handleExternalDragleave"
        @dragend="handleExternalDragleave"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Tabs
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This component displays the document tabs on top of the editor.
 *
 * END HEADER
 */

import { displayTabbarContext } from './tabs-context'
import tippy from 'tippy.js'
import { nextTick, computed, ref, watch, onMounted, onBeforeUnmount, onUpdated } from 'vue'
import { useDocumentTreeStore } from 'source/pinia'
import type { LeafNodeJSON, OpenDocument } from '@dts/common/documents'
import { pathBasename, pathDirname } from '@common/util/renderer-path-polyfill'
import type { DocumentManagerIPCAPI } from 'source/app/service-providers/documents'
import type { WindowControlsIPCAPI } from 'source/app/service-providers/windows'
import { useWorkspaceStore } from 'source/pinia/workspace-store'
import type { AnyMenuItem } from 'source/common/modules/window-register/application-menu-helper'
import { trans } from 'source/common/i18n-renderer'
import showPopupMenu from 'source/common/modules/window-register/application-menu-helper'
import { closeFile } from './file-manager/util/item-composable'
import getDocumentTitle from './util/get-document-title'

const ipcRenderer = window.ipc

const props = defineProps<{
  leafId: string
  windowId: string
}>()

const showScrollers = ref<boolean>(false)
const resizeObserver = new ResizeObserver(() => {
  requestAnimationFrame(() => {
    maybeActivateScrollers()
  })
})

// Is there a document being dragged over this tabbar?
const documentTabDragOver = ref<boolean>(false)
// Is the document originating from here? (If so we should not display the
// dropzone)
const documentTabDragOverOrigin = ref<boolean>(false)

const workspaceStore = useWorkspaceStore()
const documentTreeStore = useDocumentTreeStore()

const container = ref<HTMLDivElement|null>(null)
const node = computed<LeafNodeJSON|undefined>(() => documentTreeStore.paneData.find((leaf: LeafNodeJSON) => leaf.id === props.leafId))
const openFiles = computed(() => node.value?.openFiles ?? [])
const activeFile = computed(() => node.value?.activeFile ?? null)
const modifiedPaths = computed(() => documentTreeStore.modifiedDocuments)
const unsavedChangesLabel = trans('Unsaved changes')

watch(activeFile, () => {
  // Make sure the activeFile is in view
  // We must wait until Vue has actually applied the active class to the
  // new file tab so that our handler retrieves the correct one, not the old.
  nextTick()
    .then(scrollActiveFileIntoView)
    .catch(err => console.error(err))
})

onMounted(() => {
  // Listen for shortcuts so that we can switch tabs programmatically
  ipcRenderer.on('shortcut', (event, shortcut) => {
    if (documentTreeStore.lastLeafId !== props.leafId) {
      return // Doesn't apply to this pane
    }

    const currentIdx = openFiles.value.findIndex(elem => activeFile.value !== null && elem.path === activeFile.value.path)
    if (shortcut === 'previous-tab') {
      if (currentIdx > 0) {
        selectFile(openFiles.value[currentIdx - 1])
      } else {
        selectFile(openFiles.value[openFiles.value.length - 1])
      }
    } else if (shortcut === 'next-tab') {
      if (currentIdx < openFiles.value.length - 1) {
        selectFile(openFiles.value[currentIdx + 1])
      } else {
        selectFile(openFiles.value[0])
      }
    } else if (shortcut === 'close-window') {
      if (documentTreeStore.lastLeafId !== props.leafId) {
        return // Otherwise all document tabs would close one file at the same
        // time
      }
      // The tab bar has the responsibility to first close the activeFile if
      // there is one. If there is none, it should send a request to close
      // this window as if the user had clicked on the close-button.
      if (currentIdx > -1) {
        // There's an active file, so request the closure
        ipcRenderer.invoke('documents-provider', {
          command: 'close-file',
          payload: {
            path: openFiles.value[currentIdx].path,
            leafId: props.leafId,
            windowId: props.windowId
          }
        } as DocumentManagerIPCAPI)
          .catch(e => console.error(e))
      } else {
        // No more open files, so request closing of the window
        // TODO: This must be managed centrally
        // ipcRenderer.send('window-controls', { command: 'win-close' })
      }
    } else if (shortcut === 'rename-file') {
      // Renaming via shortcut (= Cmd/Ctrl+R) works via a tooltip underneath
      // the corresponding filetab. First, make sure the container is visible
      scrollActiveFileIntoView()

      const containerElement = container.value?.querySelector('.active')
      if (containerElement == null) {
        return
      }

      const wrapper = document.createElement('div')
      wrapper.classList.add('file-rename')

      const input = document.createElement('input')
      input.style.backgroundColor = 'transparent'
      input.style.border = 'none'
      input.style.color = 'white'
      input.value = pathBasename(openFiles.value[currentIdx].path)

      wrapper.appendChild(input)

      // Then do the magic
      const instance = tippy(containerElement, {
        content: wrapper,
        allowHTML: true,
        interactive: true,
        placement: 'bottom',
        showOnCreate: true, // Immediately show the tooltip
        arrow: true, // Arrow for these tooltips
        onShown: function () {
          input.focus()
          // Select from the beginning until the last dot
          input.setSelectionRange(0, input.value.lastIndexOf('.'))
        }
      })

      input.addEventListener('keydown', (event) => {
        if (![ 'Enter', 'Escape' ].includes(event.key)) {
          return
        }

        if (event.key === 'Enter' && input.value.trim() !== '') {
          ipcRenderer.invoke('application', {
            command: 'file-rename',
            payload: {
              path: openFiles.value[currentIdx].path,
              name: input.value
            }
          })
            .catch(e => console.error(e))
        }
        instance.hide()
      })
    }
  })

  if (container.value !== null) {
    resizeObserver.observe(container.value)
  }
})

onBeforeUnmount(() => {
  if (container.value !== null) {
    resizeObserver.unobserve(container.value)
  }
})

onUpdated(maybeActivateScrollers)

function maybeActivateScrollers (): void {
  if (container.value === null) {
    return
  }

  // First, get the total available width for the container
  const containerWidth = container.value.getBoundingClientRect().width
  // Second, get the total width of all tabs
  const tabWidth = Array.from(
    container.value.querySelectorAll<HTMLDivElement>('[role="tab"]')
  )
    .map(elem => elem.getBoundingClientRect().width)
    .reduce((width, acc) => width + acc, 0)

  // If the total width of all tabs is larger, activate the scrollers, else
  // disable them
  showScrollers.value = tabWidth > containerWidth
}

function scrollActiveFileIntoView (): void {
  if (container.value === null) {
    return
  }

  // First, we need to find the tab displaying the active file
  const elem = container.value.querySelector('.active')
  if (elem === null || !(elem instanceof HTMLDivElement)) {
    return // The container is not yet present
  }
  // Then, find out where the element is ...
  const left = elem.offsetLeft
  const right = left + elem.getBoundingClientRect().width
  // ... with respect to the container
  const leftEdge = container.value.scrollLeft
  const containerWidth = container.value.getBoundingClientRect().width
  const rightEdge = leftEdge + containerWidth

  if (left < leftEdge) {
    // The active tab is (partially) hidden to the left -> Decrease scrollLeft
    container.value.scrollLeft -= leftEdge - left
  } else if (right > rightEdge) {
    // The active tab is (partially) hidden to the right -> Increase scrollLeft
    container.value.scrollLeft += right - rightEdge
  }
}

function scrollLeft (): void {
  if (container.value === null || container.value.scrollLeft === 0) {
    return // Can't scroll further
  }

  // Get the first partially hidden file from the right. For that we first
  // need a list of all tabs. NOTE that we have to convert the nodelist to
  // an array manually. Also, we know every element will be a DIV.
  const tabs = [...container.value.querySelectorAll('[role="tab"]')] as HTMLDivElement[]

  // Test this from the back
  tabs.reverse()

  // Find the first tab whose left border is hidden behind the left edge of
  // the container
  for (const tab of tabs) {
    const left = tab.offsetLeft
    const leftEdge = container.value.scrollLeft

    if (left < leftEdge) {
      tab.scrollIntoView({ inline: 'start' })
      break
    }
  }
}

function scrollRight (): void {
  if (container.value === null) {
    return
  }

  // Similar to scrollLeft, this does the same for the right hand side
  const tabs = [...container.value.querySelectorAll('[role="tab"]')] as HTMLDivElement[]

  // Find the first tab whose right border is hidden behind the right edge
  // of the container
  const rightEdge = container.value.scrollLeft + container.value.getBoundingClientRect().width
  for (const tab of tabs) {
    const right = tab.offsetLeft + tab.getBoundingClientRect().width

    // NOTE: This is the width of the arrow buttons; TODO: Make dynamic!
    if (right > rightEdge + 40) {
      tab.scrollIntoView({ inline: 'end' })
      break
    }
  }
}

function hasDuplicate (doc: OpenDocument): boolean {
  const focalTabname = getDocumentTitle(doc).toLowerCase()
  const duplicates = openFiles.value.filter(doc => {
    return getDocumentTitle(doc).toLowerCase() === focalTabname
  })

  // NOTE that `doc` is also contained in `openFiles`, i.e. we should have 1
  return duplicates.length !== 1
}

function getDirBasename (doc: OpenDocument): string {
  return pathBasename(pathDirname(doc.path))
}

function getAccessibleTabLabel (doc: OpenDocument): string {
  const title = getDocumentTitle(doc)
  return modifiedPaths.value.includes(doc.path)
    ? `${title} — ${unsavedChangesLabel}`
    : title
}

/**
 * Handles a click on the close button
 *
 * @param   {MouseEvent}    event  The triggering event
 * @param   {OpenDocument}  file   The file descriptor
 */
function handleClickClose (event: MouseEvent, file: OpenDocument): void {
  if (event.button < 2) {
    // It was either a left-click (button === 0) or an auxiliary/middle
    // click (button === 1), so we should prevent the event from bubbling up
    // and triggering other events. If it was a right-button click
    // (button === 2), we should let it bubble up to the container to show
    // the context menu.
    // See: https://developer.mozilla.org/en-US/docs/Web/API/MouseEvent/button#return_value
    event.stopPropagation()
    event.preventDefault()
  } else {
    return // We don't handle this event here.
  }

  ipcRenderer.invoke('documents-provider', {
    command: 'close-file',
    payload: {
      path: file.path,
      windowId: props.windowId,
      leafId: props.leafId
    }
  } as DocumentManagerIPCAPI)
    .catch(e => console.error(e))
}

/**
 * Handles a click on the filename
 *
 * @param   {MouseEvent}    event  The triggering event
 * @param   {OpenDocument}  file   The file descriptor
 */
function handleClickFilename (event: MouseEvent, file: OpenDocument): void {
  if (event.button === 0) {
    // It was a left-click. (We must check because otherwise we would also
    // perform this action on a right-click (button === 2), but that event
    // must be handled by the container).
    selectFile(file)
  }
}

/**
 * Handles a middle-mouse click on the filename
 *
 * Middle-mouse clicks are handled separately through a `mouseup` event,
 * to prevent unintentional pasting on Linux systems (#2663).
 *
 * @param   {MouseEvent}    event  The triggering event
 * @param   {OpenDocument}  file   The file descriptor
 */
function handleMiddleMouseClick (event: MouseEvent, file: OpenDocument): void {
  if (event.button === 1) {
    // It was a middle-click (auxiliary button), so we should close
    // the file.
    event.preventDefault() // Otherwise, on Windows we'd have a middle-click-scroll
    handleClickClose(event, file)
  }
}

function selectFile (file: OpenDocument): void {
  // NOTE: We're handling active file setting via the open-file command. As
  // long as a given file is already open, the document manager will simply
  // set it as active. That is why we don't provide the newTab property.
  ipcRenderer.invoke('documents-provider', {
    command: 'open-file',
    payload: { path: file.path, windowId: props.windowId, leafId: props.leafId }
  } as DocumentManagerIPCAPI)
    .catch(e => console.error(e))
}

function handleTabbarContext (event: MouseEvent): void {
  // If the person didn't click on a file, let them to close the whole leaf
  displayTabbarContext(event, (clickedID: string) => {
    if (clickedID === 'close-leaf') {
      ipcRenderer.invoke('documents-provider', {
        command: 'close-leaf',
        payload: {
          leafId: props.leafId,
          windowId: props.windowId
        }
      } as DocumentManagerIPCAPI).catch(e => console.error(e))
    }
  })
}

function handleContextMenu (event: MouseEvent, doc: OpenDocument): void {
  const descriptor = workspaceStore.descriptorMap.get(doc.path)
  if (descriptor === undefined || descriptor.type === 'directory') {
    return
  }

  const isMac = process.platform === 'darwin'
  const isWin = process.platform === 'win32'

  const items: AnyMenuItem[] = [
    {
      label: trans('Close tab'),
      type: 'normal',
      enabled: !doc.pinned,
      action () {
        ipcRenderer.invoke('documents-provider', {
          command: 'close-file',
          payload: { path: descriptor.path, leafId: props.leafId, windowId: props.windowId }
        } satisfies DocumentManagerIPCAPI).catch(e => console.error(e))
      }
    },
    {
      label: trans('Close other tabs'),
      type: 'normal',
      action () {
        for (const openFile of openFiles.value) {
          if (openFile.path === descriptor.path) {
            continue
          }

          ipcRenderer.invoke('documents-provider', {
            command: 'close-file',
            payload: { path: openFile.path, leafId: props.leafId, windowId: props.windowId }
          } satisfies DocumentManagerIPCAPI).catch(e => console.error(e))
        }
      }
    },
    {
      label: trans('Close all tabs'),
      type: 'normal',
      enabled: !doc.pinned,
      action () {
        for (const openFile of openFiles.value) {
          ipcRenderer.invoke('documents-provider', {
            command: 'close-file',
            payload: { path: openFile.path, leafId: props.leafId, windowId: props.windowId }
          } satisfies DocumentManagerIPCAPI).catch(e => console.error(e))
        }
      }
    },
    {
      type: 'separator'
    },
    {
      label: trans('Move'),
      type: 'submenu',
      enabled: !doc.pinned,
      submenu: [
        {
          label: trans('Move to start'),
          enabled: !isFirstUnpinned(doc.path),
          type: 'normal',
          action () { moveFile(doc.path, 'start') }
        },
        {
          label: trans('Move to end'),
          enabled: !isLast(doc.path),
          type: 'normal',
          action () { moveFile(doc.path, 'end') }
        }
      ]
    },
    {
      label: doc.pinned ? trans('Unpin tab') : trans('Pin tab'),
      type: 'normal',
      action () {
        ipcRenderer.invoke('documents-provider', {
          command: 'set-pinned',
          payload: {
            path: doc.path, leafId: props.leafId, windowId: props.windowId, pinned: !doc.pinned
          }
        } satisfies DocumentManagerIPCAPI).catch(e => console.error(e))
      }
    },
    {
      type: 'separator'
    },
    {
      label: trans('Copy filename'),
      type: 'normal',
      action () {
        navigator.clipboard.writeText(descriptor.name).catch(err => console.error(err))
      }
    },
    {
      label: trans('Copy path'),
      type: 'normal',
      action () {
        navigator.clipboard.writeText(descriptor.path).catch(err => console.error(err))
      }
    },
    {
      label: isMac ? trans('Reveal in Finder') : isWin ? trans('Reveal in Explorer') : trans('Reveal in File Browser'),
      type: 'normal',
      action () {
        ipcRenderer.send('window-controls', {
          command: 'show-item-in-folder',
          payload: { itemPath: descriptor.path }
        } satisfies WindowControlsIPCAPI)
      }
    },
    {
      label: trans('Copy ID'),
      type: 'normal',
      enabled: descriptor.type === 'file' && descriptor.id !== '',
      action () {
        if (descriptor.type === 'file' && descriptor.id !== '') {
          navigator.clipboard.writeText(descriptor.id).catch(err => console.error(err))
        }
      }
    },
    {
      type: 'separator'
    },
    {
      label: trans('Close file'),
      type: 'normal',
      enabled: workspaceStore.rootDescriptors.includes(descriptor),
      action () {
        closeFile(descriptor.path)
      }
    },
  ]

  const point = { x: event.clientX, y: event.clientY }
  showPopupMenu(point, items)
}

/**
 * Managed the begin of a drag of one of the internal document tabs we have
 * here on this tabbar.
 *
 * @param   {DragEvent}  event     The Drag event
 * @param   {string}     filePath  The file to be dragged
 */
function handleDragStart (event: DragEvent, filePath: string): void {
  const DELIM = (process.platform === 'win32') ? ';' : ':'
  // NOTE: When retrieving this data, destructure as an array and capture
  // any remaining parts with `...filePath` and re-join with DELIM to
  // account for the fact that Unixoid systems allow colons in paths.
  const data = [ props.windowId, props.leafId, filePath ].join(DELIM)
  event.dataTransfer?.setData('zettlr/document-tab', data)
  documentTabDragOverOrigin.value = true
}

/**
 * This function handles internal document tabs (i.e. the reordering of
 * document tabs belonging to this tabbar)
 *
 * @param   {DragEvent}  event  The drag event
 */
function handleDrag (event: DragEvent): void {
  if (container.value === null) {
    return
  }

  const tab = event.target as Element
  const tablist = tab.parentNode as Element
  let coordsX = event.clientX
  let coordsY = event.clientY

  // Ensure the coords are somewhere inside the tablist. NOTE that exactly
  // the border would only select the tablist, not the actual tab at that
  // point. NOTE that the value of five is arbitrary and relies on the fact
  // that the tablist only contains tabs.
  const { left, top, right, bottom, height } = container.value.getBoundingClientRect()
  // Stop handling if the user drags the tab out of the document tab bar
  // This is so that editor instances can enable splitting via drag&drop
  if (coordsX < left - 10 || coordsX > right + 10 || coordsY < top - 10 || coordsY > bottom + 10) {
    return
  }

  const middle = height / 2
  if (coordsX < left) {
    coordsX = left + 5
  }

  if (coordsX > right) {
    coordsX = right - 5
  }

  if (coordsY < top) {
    coordsY = top + middle
  }

  if (coordsY > bottom) {
    coordsY = bottom - middle
  }

  let swapItem: Element = tab
  const elemAtCoords = document.elementFromPoint(coordsX, coordsY)
  if (elemAtCoords !== null) {
    swapItem = elemAtCoords
  }

  // We need to make sure we got the DIV, not one of the containing spans
  while (swapItem.getAttribute('role') !== 'tab') {
    if (swapItem.parentNode === document) {
      break // Don't overdo it
    }
    swapItem = swapItem.parentNode as Element
  }

  if (tablist === swapItem.parentNode) {
    // @ts-expect-error TODO This didn't lead to a bug yet, but may
    swapItem = swapItem !== tab.nextSibling ? swapItem : swapItem.nextSibling
    tablist.insertBefore(tab, swapItem)
  }
}

/**
 * This event is solely used when the user drops a document tab onto the
 * origin tabbar to see if something has changed and resort the document
 * tabs as necessary.
 *
 * @param   {DragEvent}  event  The drag event
 */
function handleDragEnd (event: DragEvent): void {
  documentTabDragOverOrigin.value = false
  if (container.value === null) {
    return
  }

  // Here we just need to inspect the actual order and notify the main
  // process of that order.
  const newOrder: string[] = []
  for (let i = 0; i < container.value.children.length; i++) {
    if (container.value.children[i].getAttribute('role') !== 'tab') {
      // There may be other children in the element, such as the scrollers
      continue
    }
    const fpath = container.value.children[i].getAttribute('data-path')
    if (fpath === null) {
      console.warn(`Could not determine file path of document tab index ${i}: data-path was empty.`)
      continue
    }

    newOrder.push(fpath)
  }

  const originalOrdering = openFiles.value.map(file => file.path)

  // Did the order change at all?
  let somethingChanged = false
  for (let i = 0; i < newOrder.length; i++) {
    if (newOrder[i] !== originalOrdering[i]) {
      somethingChanged = true
      break
    }
  }

  if (!somethingChanged) {
    return
  }

  // Now that we have the correct NEW ordering, we need to temporarily
  // restore the old ordering, because otherwise Vue will be confused since
  // it needs to keep track of the element ordering, and we just messed with
  // that big time.
  const targetElement = event.target as Element|null
  if (targetElement === null) {
    return
  }

  const dataPath = targetElement.getAttribute('data-path')

  if (dataPath === null) {
    return
  }

  const originalIndex = originalOrdering.indexOf(dataPath)
  if (originalIndex === 0) {
    container.value.insertBefore(targetElement, container.value.children[0])
  } else if (originalIndex === container.value.children.length - 1) {
    container.value.insertBefore(targetElement, null) // null means append at the end
  } else {
    container.value.insertBefore(targetElement, container.value.children[originalIndex + 1])
  }

  ipcRenderer.invoke('documents-provider', {
    command: 'sort-open-files',
    payload: {
      newOrder,
      windowId: props.windowId,
      leafId: props.leafId
    }
  } satisfies DocumentManagerIPCAPI)
    .catch(err => console.error(err))
}

/**
 * Returns true if the item identified by `itemPath` is the first non-pinned
 * item in the tab list.
 *
 * @param   {string}   itemPath  The item
 *
 * @return  {boolean}            Whether it's the first unpinned.
 */
function isFirstUnpinned (itemPath: string): boolean {
  const idx = getIndexInTabList(itemPath)
  const firstUnpinned = openFiles.value.findIndex(doc => !doc.pinned)
  return idx === firstUnpinned
}

/**
 * Returns true if the item identified by `itemPath` is the last item in the
 * open files.
 *
 * @param   {string}   itemPath  The item
 *
 * @return  {boolean}            Whether it's last
 */
function isLast (itemPath: string): boolean {
  const idx = getIndexInTabList(itemPath)
  return idx === openFiles.value.length - 1
}

/**
 * Returns the index of the item identified by `itemPath` in the list of open
 * files.
 *
 * @param   {string}  itemPath  The item
 *
 * @return  {number}            The item's index
 */
function getIndexInTabList (itemPath: string): number {
  return openFiles.value.findIndex(doc => doc.path === itemPath)
}

/**
 * Moves the file identified by `itemPath` to the first or last position in the
 * tab bar, indicated by `where`.
 *
 * @param  {string}         itemPath  The item to move
 * @param  {'start'|'end'}  where     Where to move the file to
 */
function moveFile (itemPath: string, where: 'start'|'end') {
  const currentIdx = getIndexInTabList(itemPath)

  if (currentIdx < 0) {
    return
  }

  const newOrder = openFiles.value.map(f => f.path)
  newOrder.splice(currentIdx, 1)

  if (where === 'start') {
    newOrder.unshift(itemPath)
  } else {
    newOrder.push(itemPath)
  }

  ipcRenderer.invoke('documents-provider', {
    command: 'sort-open-files',
    payload: {
      newOrder,
      windowId: props.windowId,
      leafId: props.leafId
    }
  } satisfies DocumentManagerIPCAPI)
    .catch(err => console.error(err))
}

/**
 * This function is used when something *external* has been dropped onto the
 * tabbar. In this case, we need to execute a move command (if applicable
 * analogously to the MainEditor component).
 *
 * @param   {DragEvent}  event  The drag event
 */
function handleExternalDrop (event: DragEvent): void {
  documentTabDragOver.value = false
  const DELIM = (process.platform === 'win32') ? ';' : ':'
  const documentTab = event.dataTransfer?.getData('zettlr/document-tab')
  if (documentTab === undefined) {
    return
  } else if (!documentTab.includes(DELIM)) {
    return
  }

  // The user dropped the file onto the origin (this indicates a bug as
  // the dropzone shouldn't even be on the DOM in that case)
  if (documentTabDragOverOrigin.value) {
    console.error('A document tab has been dropped onto its origin, but the dropzone was in the DOM. This is a bug.')
    documentTabDragOverOrigin.value = false
    return
  }

  // At this point, we have received a drop we need to handle it. The drag
  // data contains both the origin and the path, separated by the $PATH
  // delimiter -> window:leaf:absPath
  const [ originWindow, originLeaf, ...filePath ] = documentTab.split(DELIM)
  // Now actually perform the act
  ipcRenderer.invoke('documents-provider', {
    command: 'move-file',
    payload: {
      originWindow,
      targetWindow: props.windowId,
      originLeaf,
      targetLeaf: props.leafId,
      path: filePath.join(DELIM)
    }
  } as DocumentManagerIPCAPI)
    .catch(err => console.error(err))
}

/**
 * This event is used to indicate to the user if they can drop a document
 * tab onto this tabbar. This gives the tabbar a blue-ish shimmer (similarly
 * to the dropzones in the MainEditor component) to indicate that the user
 * can drop a document tab on here.
 *
 * @param   {DragEvent}  event  The drag event
 */
function handleExternalDragover (event: DragEvent): void {
  if (documentTabDragOverOrigin.value) {
    return // The document tab is coming from this tabbar
  }

  const hasDocumentTab = event.dataTransfer?.types.includes('zettlr/document-tab') ?? false
  if (hasDocumentTab) {
    documentTabDragOver.value = true
  } else {
    documentTabDragOver.value = false
  }
}

/**
 * This is being called on dragleave and some other, related external events
 * to reset the internal state so that the dropzone disappears.
 *
 * @param   {DragEvent}  _event  The drag event, which this handler ignores
 */
function handleExternalDragleave (_event: DragEvent): void {
  documentTabDragOver.value = false
}
</script>

<style lang="less">
@tabbar-height: 30px;
// Unsaved work gets its own hue rather than the theme's own accent, which
// already means "this is the active tab". Amber reads as attention on both the
// light tab bar and the dark one, so one value serves every platform and theme
// block instead of each restating its own.
@unsaved-accent: rgb(224, 122, 26);

body div.document-tablist-wrapper {
  position: relative;

  &.scrollers-active { padding: 0 20px; }

  div.scroller {
    position: absolute;
    line-height: 30px;
    width: 20px;
    text-align: center;
    background-color: inherit;

    &:hover { background-color: rgb(200, 200, 210); }

    &.left { left: 0px; }
    &.right { right: 0px; }
  }
}

body div.tab-container {
  width: 100%;
  height: 31px;
  background-color: rgb(215, 215, 215);
  border-bottom: 1px solid grey;
  display: flex;
  overflow-x: auto;

  .dropzone {
    position: absolute;
    transition: all 0.3s ease;
    background-color: rgba(21, 61, 107, 0.5);
    top: 0;
    left: 0;
    bottom: 0;
    right: 0;
  }

  // In case of an overflow, hide the scrollbar so that scrolling left/right
  // remains possible, but no thicc scrollbar in the way!
  &::-webkit-scrollbar { display: none; }
  scroll-behavior: smooth;

  div[role="tab"] {
    display: flex;
    position: relative;
    min-width: fit-content;
    max-width: 150px;
    line-height: @tabbar-height;
    padding: 0 10px; // Give the filenames a little more spacing

    &:hover { background-color: rgb(200, 200, 210); }

    .filename {
      line-height: 30px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 160px;
    }

    .deduplicate {
      font-style: italic;
      font-size: 80%;
      opacity: 0.8;
    }

    // Unsaved changes read as an amber dot in the close control's own slot,
    // which the close cross takes back the moment the pointer arrives. The
    // previous indicator was a '* ' prefix on the filename: it shifted the
    // title sideways, competed with the text, and was easy to miss.
    //
    // Positioned over the close control's box rather than beside it, so an
    // unsaved tab is no wider than a saved one and the row does not twitch as
    // the pointer travels along it.
    .modification-indicator {
      position: absolute;
      right: 10px; // matches the tab's own horizontal padding
      top: 0;
      width: 10px;
      height: @tabbar-height;

      &::before {
        content: '';
        position: absolute;
        top: 50%;
        left: 50%;
        width: 8px;
        height: 8px;
        margin: -4px 0 0 -4px;
        border-radius: 50%;
        background-color: @unsaved-accent;
      }
    }

    // The close cross is a pointer affordance, shown on the tab under the
    // cursor. It used to sit on every tab at once, which is what made the dot
    // fail its job: with a glyph already in that slot on all four tabs, an
    // unsaved one had to be picked out by telling a 7px circle from a 7px
    // cross. Hidden rather than removed, so the tab keeps its width and the
    // row does not reflow as the pointer travels.
    .close { visibility: hidden; }
    &:hover .close { visibility: visible; }
    &:hover .modification-indicator { visibility: hidden; }

    // A dot alone is a fair signal for an unsaved shopping list and a poor one
    // for unsaved research. The top edge carries the same amber, so the state
    // registers from the row's silhouette before any glyph is resolved — and it
    // stays put under the pointer, when the dot has yielded its slot.
    //
    // A pseudo-element, not a box-shadow: the darwin and win32 blocks
    // both set `box-shadow` on `div[role="tab"]:not(.active)` for their inset
    // top shading, and that rule lands later in the sheet — an unsaved tab that
    // was not the active one lost its bar entirely, which is exactly the tab
    // whose state the author most needs to see.
    &.modified::after {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
      background-color: @unsaved-accent;
    }

    .close {
      font-size: 14px;
      margin-left: 5px;
      width: 10px;
      height: @tabbar-height;
      line-height: @tabbar-height;
      text-align: center;
      border-radius: @tabbar-height;
      display: inline-block;
    }

    transition: 0.2s background-color ease;
  }
}

body.darwin {
  div.document-tablist-wrapper {
    div.scroller {
      background-color: rgb(230, 230, 230);
      color: rgb(83, 83, 83);
      box-shadow: inset 0px 5px 4px -5px rgba(0, 0, 0, .4);

      &:hover { background-color: rgb(214, 214, 214); }

      &.left { border-right: 1px solid rgb(200, 200, 200); }
      &.right { border-left: 1px solid rgb(200, 200, 200); }
    }
  }

  div.tab-container {
    border-bottom: 1px solid rgb(220, 220, 220);

    div[role="tab"] {
      text-align: center;
      font-family: system-ui, sans-serif;
      font-size: 11px;
      background-color: rgb(230, 230, 230);
      border-right: 1px solid rgb(200, 200, 200);
      color: rgb(83, 83, 83);

      .filename {
        padding: 0 5px;
        margin: 0 10px;
      }

      .deduplicate {
        margin-right: 10px;
      }

      &.pinned .filename { margin: 0; }

      &:not(.active) {
        // As a reminder, from Mozilla docs:
        // inset | offset-x | offset-y | blur-radius | spread-radius | color
        box-shadow: inset 0px 5px 4px -5px rgba(0, 0, 0, .4);
      }

      &:last-child { border-right: none; }

      &:hover {
        background-color: rgb(214, 214, 214);
        .close { opacity: 1; }
      }

      &.active {
        background-color: rgb(244, 244, 244);
        color: inherit;
      }

      .close {
        font-size: 16px;
        color: rgb(90, 90, 90);
        opacity: 0;
        transition: opacity 0.2s ease;
        border-radius: 2px;
        position: absolute;
        right: 0px;
        width: (@tabbar-height / 3 * 1.9);
        height: (@tabbar-height / 3 * 1.9);
        margin: (@tabbar-height / 3 * 0.55);
        line-height: (@tabbar-height / 3 * 1.9);
        top: 0;
        left: 0;

        &:hover {
          background-color: rgb(200, 200, 200);
        }
      }
    }
  }

  &.dark {
    div.document-tablist-wrapper {
      div.scroller {
        background-color: rgb(22, 22, 22);
        color: rgb(233, 233, 233);

        &:hover { background-color: rgb(32, 34, 36); }

        &.left { border-color: rgb(32, 34, 36); }
        &.right { border-color: rgb(32, 34, 36); }
      }
    }

    div.tab-container {
      border-bottom-color: rgb(11, 11, 11);
      background-color: rgb(22, 22, 22);

      div[role="tab"] {
        color: rgb(233, 233, 233);
        background-color: rgb(22, 22, 22);
        border-color: rgb(22, 22, 22);

        &:hover {
          background-color: rgb(32, 34, 36);
        }

        &.active {
          background-color: rgb(51, 51, 51);
          border-color: rgb(70, 70, 70);
        }
      }
    }
  }
}

body.win32 {
  div.document-tablist-wrapper {
    div.scroller {
      &.left { border-right: 1px solid rgb(180, 180, 180); }
      &.right { border-left: 1px solid rgb(180, 180, 180); }
    }
  }

  div.tab-container {
    border-bottom: none;

    div[role="tab"] {
      font-size: 12px;

      &:not(:last-child) {
        border-right: 1px solid rgb(180, 180, 180);
      }

      &.active {
        background-color: rgb(172, 172, 172);
        color: white;
      }
    }
  }

  &.dark {
    div.document-tablist-wrapper {
      div.scroller {
        &:hover { background-color: rgb(53, 53, 53); }

        &.left { border-color: rgb(120, 120, 120); }
        &.right { border-color: rgb(120, 120, 120) }
      }
    }

    div.tab-container {
      background-color: rgb(11, 11, 11);

      div[role="tab"] {
        border-color: rgb(120, 120, 120);

        &:hover { background-color: rgb(53, 53, 53); }

        &.active {
          background-color: rgb(50, 50, 50);
        }
      }
    }
  }
}

body.linux {
  div.document-tablist-wrapper {
    div.scroller {
      line-height: 29px;
      background-color: rgb(235, 235, 235);
      &:hover { background-color: rgb(200, 200, 200); }

      &.left { border-right: 1px solid rgb(200, 200, 200); }
      &.right { border-left: 1px solid rgb(200, 200, 200); }
    }
  }
  div.tab-container {

    div[role="tab"] {
      font-size: 12px;
      background-color: rgb(235, 235, 235); // Almost same colour as toolbar
      &:hover { background-color: rgb(200, 200, 200); }

      &:not(:last-child) { border-right: 1px solid rgb(200, 200, 200); }
      &.active { border-bottom: 3px solid var(--system-accent-color, --c-primary); } // TODO: Which colour?
      .close { font-size: 18px; }
    }
  }

  &.dark {
    div.document-tablist-wrapper {
      div.scroller {
        background-color: #5a5a5a;
        &:hover { background-color: rgb(53, 53, 53); }

        &.left { border-color: 1px solid rgb(120, 120, 120); }
        &.right { border-color: 1px solid rgb(120, 120, 120); }
      }
    }

    div.tab-container {
      background-color: rgb(11, 11, 11);

      div[role="tab"] {
        border-color: rgb(120, 120, 120);
        background-color: #5a5a5a;

        &:hover { background-color: rgb(53, 53, 53); }
        &.active {
          background-color: rgb(50, 50, 50);
          border-bottom-color: var(--system-accent-color, --c-primary);
        }
      }
    }
  }
}
</style>
