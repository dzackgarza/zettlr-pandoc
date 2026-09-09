<template>
  <div class="other-files-panel">
    <!-- Render all attachments -->
    <p
      v-if="attachments.length === 0"
      class="other-files-empty"
    >
      {{ noAttachmentsMessage }}
    </p>
    <template
      v-for="(folder, fIdx) in attachments"
      v-else
      :key="fIdx"
    >
      <div
        class="chrome-group-label"
        :title="folder.path"
      >
        {{ folder.path }}
      </div>

      <template v-if="folder.files.length > 0">
        <a
          v-for="(attachment, idx) in folder.files"
          :key="idx"
          class="attachment"
          draggable="true"
          href="#"
          :data-link="attachment.path"
          :title="attachment.path"
          @click.prevent="handleClick(attachment.path)"
          @dragstart="handleDragStart($event, attachment.path)"
        >
          <img
            v-if="hasPreview(attachment.path)"
            :src="getPreviewImageData(attachment.path)"
          >
          <!-- eslint-disable vue/no-v-html -- getAttachmentIconMarkup uses the repository-bundled SVG and escapes the file-derived label as XML text before substitution. -->
          <span
            v-else
            v-html="getAttachmentIconMarkup(attachment.ext)"
          />
          <!-- eslint-enable vue/no-v-html -->

          <span class="attachment-name">{{ attachment.name }}</span>
        </a>
      </template>
      <span
        v-else
        class="other-files-empty"
      >
        {{ noAttachmentsMessage }}
      </span>
    </template>
  </div>
</template>

<script setup lang="ts">
import { trans } from '@common/i18n-renderer'
import makeValidUri from '@common/util/make-valid-uri'
import { computed } from 'vue'
import { useConfigStore } from 'source/pinia'
import { hasImageExt } from 'source/common/util/file-extention-checks'
import { useWorkspaceStore } from 'source/pinia/workspace-store'
import { getAttachmentIconMarkup } from './attachment-icon-markup'

const ipcRenderer = window.ipc

const searchParams = new URLSearchParams(window.location.search)
const windowIdParam = searchParams.get('window_id')

if (windowIdParam === null) {
  throw new Error('windowID was null')
}

// Re-binding after the guard keeps the narrowing visible inside closures.
const windowId: string = windowIdParam

const configStore = useConfigStore()
const workspaceStore = useWorkspaceStore()

const noAttachmentsMessage = trans('No other files')

const attachments = computed(() => workspaceStore.otherFiles)

/**
 * Adds additional data to the dragevent
 *
 * @param   {DragEvent}  event           The drag event
 * @param   {string}  attachmentPath  The path to add as a file
 */
function handleDragStart (event: DragEvent, attachmentPath: string): void {
  // Indicate with custom data that this is a file from the sidebar
  const data = { type: 'other', path: attachmentPath }
  event.dataTransfer?.setData('text/x-zettlr-file', JSON.stringify(data))
}

function handleClick (filePath: string) {
  if (hasImageExt(filePath) && configStore.config.files.images.openWith === 'zettlr') {
    // Open this image in Zettlr
    ipcRenderer.invoke('documents-provider', {
      command: 'open-file',
      // We leave leafId undefined
      payload: { path: filePath, windowId }
    })
      .catch(e => console.error(e))
  } else {
    // Open the file externally (again, NOTE, this only works because main
    // intercepts every navigation attempt).
    window.location.href = makeValidUri(filePath)
  }

}

/**
 * Returns true for any attachments that Zettlr can show a preview for
 *
 * @param   {string}   attachmentPath  The absolute path to the attachment
 *
 * @return  {boolean}                  Returns true for previewable attachments
 */
function hasPreview (attachmentPath: string): boolean {
  if (hasImageExt(attachmentPath)) {
    return true
  }

  return false
}

/**
 * Returns a string that can be used as an Image source to show the preview for
 * the provided file.
 *
 * @param   {string}  attachmentPath  The absolute path to the attachment
 *
 * @return  {string}                  The image src attribute's contents
 */
function getPreviewImageData (attachmentPath: string): string {
  if (hasImageExt(attachmentPath)) {
    return makeValidUri(attachmentPath) // Can be used (almost) as-is
  }

  return ''
}
</script>

<style lang="less">
.other-files-panel {
  height: 100%;
  overflow-y: auto;
  font-size: var(--chrome-font-size);
}

.other-files-empty {
  display: block;
  margin: 4px 0;
  padding: 0 var(--chrome-inset);
  color: var(--chrome-text-muted);
}

a.attachment {
  display: grid;
  align-items: center;
  gap: 4px;
  grid-template-columns: 48px auto;

  padding: 4px var(--chrome-inset);
  text-decoration: none;
  color: inherit;
  // Some filenames are too long for the sidebar. However, unlike with the
  // file manager where we have the full filename visible in multiple places,
  // here we must make sure the filename is fully visible. Hence, we don't
  // use white-space: nowrap, but rather word-break: break-all.
  word-break: break-all;
  white-space: nowrap;

  span.attachment-name {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  img {
    max-width: 100%;
  }

  svg {
    width: 32px;
    height: 32px;
    margin-right: 4px;
    vertical-align: bottom;
    margin-bottom: -1px;
    // Necessary to give the extension icons the correct colour
    fill: currentColor;
  }
}

body.dark a.attachment {
  color: inherit;
}
</style>
