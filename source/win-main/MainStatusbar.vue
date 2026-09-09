<template>
  <div
    id="main-statusbar"
    class="main-statusbar"
  >
    <div
      v-if="info !== undefined"
      class="main-statusbar-group main-statusbar-left"
    >
      <button
        v-if="info.project !== undefined"
        type="button"
        class="main-statusbar-item"
        data-statusbar-item="project"
        v-bind:title="projectTitle"
        v-on:click="openProjectMenu($event)"
      >
        <cds-icon
          shape="blocks-group"
          role="presentation"
        ></cds-icon>
        <span>{{ projectCountLabel }}</span>
      </button>
      <button
        v-if="isMarkdown"
        type="button"
        class="main-statusbar-item"
        data-statusbar-item="magic-quotes"
        title="MagicQuotes"
        v-on:click="openMagicQuotesMenu($event)"
      >
        <span class="main-statusbar-chip">{{ magicQuotes.primary }}</span>
        <span class="main-statusbar-chip">{{ magicQuotes.secondary }}</span>
      </button>
      <button
        v-if="isMarkdown"
        type="button"
        class="main-statusbar-item"
        data-statusbar-item="rendering-mode"
        v-bind:title="renderingModeTitle"
        v-on:click="toggleRenderingMode()"
      >
        {{ renderingModeLabel }}
      </button>
      <button
        v-if="isMarkdown"
        type="button"
        class="main-statusbar-item"
        data-statusbar-item="readability"
        v-bind:title="readabilityTitle"
        v-bind:aria-pressed="info.readabilityMode"
        v-on:click="emit('toggle-readability')"
      >
        <cds-icon
          v-bind:shape="info.readabilityMode ? 'eye' : 'eye-hide'"
          role="presentation"
        ></cds-icon>
      </button>
      <span
        class="main-statusbar-text"
        data-statusbar-item="cursor"
      >{{ cursorLabel }}</span>
      <span
        class="main-statusbar-text"
        data-statusbar-item="words"
      >{{ wordsLabel }}</span>
      <span
        class="main-statusbar-text"
        data-statusbar-item="chars"
      >{{ charsLabel }}</span>
      <span
        v-if="inputMode !== 'default'"
        class="main-statusbar-text"
        data-statusbar-item="input-mode"
      >{{ inputModeLabel }}</span>
      <button
        v-if="info.languageTool.state === 'idle'"
        type="button"
        class="main-statusbar-item"
        data-statusbar-item="language-tool"
        v-bind:title="languageToolTitle"
        v-on:click="openLanguageToolMenu($event)"
      >
        LanguageTool: <cds-icon
          shape="check"
          role="presentation"
        ></cds-icon> {{ languageToolLanguage }}
      </button>
      <span
        v-else-if="info.languageTool.state === 'running'"
        class="main-statusbar-text"
        data-statusbar-item="language-tool"
      >
        LanguageTool: <cds-icon
          shape="hourglass"
          role="presentation"
        ></cds-icon>
      </span>
      <span
        v-else-if="info.languageTool.state === 'error'"
        class="main-statusbar-text"
        data-statusbar-item="language-tool"
      >
        LanguageTool: <cds-icon
          shape="exclamation-triangle"
          role="presentation"
        ></cds-icon> ({{ info.languageTool.message }})
      </span>
      <button
        type="button"
        class="main-statusbar-item"
        data-statusbar-item="diagnostics"
        v-bind:title="diagnosticsTitle"
        v-on:click="emit('toggle-lint-panel')"
      >
        <cds-icon
          shape="help-info"
          role="presentation"
        ></cds-icon> {{ info.diagnostics.info }}
        <cds-icon
          shape="warning-standard"
          role="presentation"
        ></cds-icon> {{ info.diagnostics.warning }}
        <cds-icon
          shape="times-circle"
          role="presentation"
        ></cds-icon> {{ info.diagnostics.error }}
      </button>
    </div>
    <div class="main-statusbar-group main-statusbar-right">
      <button
        id="statusbar-pomodoro"
        type="button"
        class="main-statusbar-item"
        v-bind:title="pomodoroLabel"
        v-bind:aria-label="pomodoroLabel"
        v-on:click="emit('pomodoro')"
      >
        <RingProgress
          v-bind:ratio="props.pomodoroRatio"
          v-bind:color="props.pomodoroColour"
          v-bind:circle-size="14"
          v-bind:line-width="2"
        ></RingProgress>
      </button>
      <span
        v-if="tasks.length > 0"
        class="main-statusbar-tasks"
        data-statusbar-item="tasks"
      >
        <IrisIndicator
          id="long-running-tasks"
          v-bind:tasks-in-progress="taskCount(TaskStatus.ongoing)"
          v-bind:tasks-success="taskCount(TaskStatus.finished)"
          v-bind:tasks-failed="taskCount(TaskStatus.error)"
          v-bind:tasks-aborted="taskCount(TaskStatus.aborted)"
          v-on:click="emit('tasks')"
        ></IrisIndicator>
      </span>
      <button
        v-if="props.updateAvailable"
        id="statusbar-update"
        type="button"
        class="main-statusbar-item main-statusbar-update"
        v-bind:title="updateLabel"
        v-on:click="emit('update')"
      >
        <cds-icon
          shape="download"
          role="presentation"
        ></cds-icon>
        <span>{{ updateLabel }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        MainStatusbar
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The main window's one status bar, spanning the window
 *                  bottom. Its left group shows the active editor from the
 *                  document info the editor publishes to the window state
 *                  store (project, MagicQuotes, rendering mode, readability,
 *                  cursor, counts, input mode, LanguageTool, diagnostics);
 *                  its right group carries the window-level items: the
 *                  Pomodoro ring, the long-running-task indicator and, when
 *                  an update exists, the update item. The bar computes
 *                  nothing about the document; it renders and emits.
 *
 * END HEADER
 */

import { computed } from 'vue'
import { trans } from '@common/i18n-renderer'
import IrisIndicator from '@common/vue/IrisIndicator.vue'
import RingProgress from '@common/vue/window/toolbar-controls/RingProgress.vue'
import localiseNumber from '@common/util/localise-number'
import { hasMarkdownExt } from '@common/util/file-extention-checks'
import showPopupMenu, { type AnyMenuItem } from '@common/modules/window-register/application-menu-helper'
import { navigationMenuItems } from '@common/modules/markdown-editor/plugins/project-info-field'
import { useConfigStore, useDocumentTreeStore, useLRTStore, useWindowStateStore } from 'source/pinia'
import { TaskStatus } from 'source/pinia/lrt-store'
import { languageToolMenuItems, magicQuotesMenuItems, magicQuotesPairFor } from './statusbar-menus'

const props = defineProps<{
  /** The Pomodoro phase's progress, 0 to 1. */
  pomodoroRatio: number
  pomodoroColour: string
  updateAvailable: boolean
}>()

const emit = defineEmits<{
  (e: 'pomodoro'): void
  (e: 'tasks'): void
  (e: 'update'): void
  (e: 'toggle-readability'): void
  (e: 'toggle-lint-panel'): void
  (e: 'set-language-tool-language', language: string): void
  (e: 'open-file', path: string): void
}>()

const configStore = useConfigStore()
const documentTreeStore = useDocumentTreeStore()
const lrtStore = useLRTStore()
const windowStateStore = useWindowStateStore()

const pomodoroLabel = trans('Pomodoro timer')
const updateLabel = trans('Update available')
const diagnosticsTitle = trans('Toggle diagnostics panel')
const renderingModeTitle = trans('Enable or disable the preview mode for Markdown files by clicking')

const info = computed(() => windowStateStore.activeDocumentInfo)
const activePath = computed(() => documentTreeStore.lastLeafActiveFile?.path)
const isMarkdown = computed(() => activePath.value !== undefined && hasMarkdownExt(activePath.value))

const countChars = computed(() => configStore.config.editor.countChars)
const inputMode = computed(() => configStore.config.editor.inputMode)
const magicQuotes = computed(() => configStore.config.editor.autoCorrect.magicQuotes)
const renderingMode = computed(() => configStore.config.display.renderingMode)

const projectTitle = computed(() => info.value?.project === undefined ? '' : trans('This file is part of project "%s"', info.value.project.name))
const projectCountLabel = computed(() => {
  const project = info.value?.project
  if (project === undefined) {
    return ''
  }
  return countChars.value
    ? trans('%s characters', localiseNumber(project.charCount))
    : trans('%s words', localiseNumber(project.wordCount))
})
const renderingModeLabel = computed(() => renderingMode.value === 'preview' ? trans('Preview') : trans('Raw'))
const readabilityTitle = computed(() => trans('Readability mode (%s)', configStore.config.editor.readabilityAlgorithm))
const cursorLabel = computed(() => info.value === undefined ? '' : `Ln ${info.value.cursor.line}, Col ${info.value.cursor.ch}`)
const wordsLabel = computed(() => info.value === undefined ? '' : trans('%s words', localiseNumber(info.value.words)))
const charsLabel = computed(() => info.value === undefined ? '' : trans('%s characters', localiseNumber(info.value.chars)))
const inputModeLabel = computed(() => 'Mode: ' + (inputMode.value === 'vim' ? 'Vim' : 'Emacs'))
const languageToolLanguage = computed(() => {
  const status = info.value?.languageTool
  if (status === undefined || status.state !== 'idle') {
    return ''
  }
  const flag = resolveFlag(status.language)
  return flag === status.language ? `(${status.language})` : flag
})
const languageToolTitle = computed(() => {
  const status = info.value?.languageTool
  return status === undefined || status.state !== 'idle' ? '' : resolveName(status.language)
})

const tasks = computed(() => lrtStore.tasks)

function taskCount (status: TaskStatus): number {
  return tasks.value.filter(task => task.status === status).length
}

function toggleRenderingMode (): void {
  configStore.setConfigValue('display.renderingMode', renderingMode.value === 'preview' ? 'raw' : 'preview')
}

function openProjectMenu (event: MouseEvent): void {
  const project = info.value?.project
  if (project === undefined) {
    return
  }
  const items: AnyMenuItem[] = [
    { id: 'none', label: project.name, type: 'normal', enabled: false },
    ...navigationMenuItems(project.navigation)
  ]
  showPopupMenu({ x: event.clientX, y: event.clientY }, items, clickedId => { emit('open-file', clickedId) })
}

function openMagicQuotesMenu (event: MouseEvent): void {
  // Stopped here so the document's context-menu handler does not close it again.
  event.stopPropagation()
  showPopupMenu({ x: event.clientX, y: event.clientY }, magicQuotesMenuItems(magicQuotes.value), clickedId => {
    const pair = magicQuotesPairFor(clickedId)
    configStore.setConfigValue('editor.autoCorrect.magicQuotes.primary', pair.primary)
    configStore.setConfigValue('editor.autoCorrect.magicQuotes.secondary', pair.secondary)
  })
}

function openLanguageToolMenu (event: MouseEvent): void {
  const status = info.value?.languageTool
  if (status === undefined || status.state !== 'idle') {
    return
  }
  event.stopPropagation()
  const items = languageToolMenuItems(status.supportedLanguages, status.overrideLanguage, configStore.config.appLang)
  showPopupMenu({ x: event.clientX, y: event.clientY }, items, clickedId => { emit('set-language-tool-language', clickedId) })
}
</script>

<script lang="ts">
import { resolveLangCode } from '@common/util/map-lang-code'

function resolveFlag (code: string): string {
  return resolveLangCode(code, 'flag')
}

function resolveName (code: string): string {
  return resolveLangCode(code, 'name')
}
</script>

<style lang="less">
body .main-statusbar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  height: 26px;
  padding: 0 var(--chrome-inset);
  box-sizing: border-box;
  border-top: 1px solid var(--chrome-border);
  background-color: var(--chrome-surface);
  color: var(--chrome-text-muted);
  font-size: var(--chrome-section-font-size);
  user-select: none;

  .main-statusbar-group {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 100%;
    min-width: 0;
  }

  .main-statusbar-left > * + * {
    border-left: 1px solid var(--chrome-border);
    padding-left: 8px;
  }

  .main-statusbar-text {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }

  .main-statusbar-chip {
    border: 1px solid currentColor;
    border-radius: 4px;
    padding: 0 4px;
  }

  button.main-statusbar-item {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    margin: 0;
    padding: 0 4px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    font: inherit;
    white-space: nowrap;
    cursor: pointer;

    &:hover {
      background-color: var(--chrome-row-hover-bg);
    }

    &[aria-pressed="true"] {
      color: var(--chrome-text);
    }

    cds-icon {
      width: 14px;
      height: 14px;
    }
  }

  .main-statusbar-left button.main-statusbar-item {
    border-radius: 0;
  }

  button.iris-indicator {
    height: 22px;
    margin: 0;
    padding: 0 4px;
    border: none;
    background: transparent;
    cursor: pointer;

    canvas {
      width: 16px;
      height: 16px;
    }
  }
}
</style>
