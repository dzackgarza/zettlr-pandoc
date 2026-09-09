<template>
  <div
    id="main-statusbar"
    class="main-statusbar"
  >
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
      <IrisIndicator
        v-if="tasks.length > 0"
        id="long-running-tasks"
        v-bind:tasks-in-progress="taskCount(TaskStatus.ongoing)"
        v-bind:tasks-success="taskCount(TaskStatus.finished)"
        v-bind:tasks-failed="taskCount(TaskStatus.error)"
        v-bind:tasks-aborted="taskCount(TaskStatus.aborted)"
        v-on:click="emit('tasks')"
      ></IrisIndicator>
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
 *                  bottom. Its right group carries the window-level items
 *                  the toolbar row used to host: the Pomodoro ring, the
 *                  long-running-task indicator and, when an update exists,
 *                  the update item. Each click reaches the window, which
 *                  anchors the item's popover to it.
 *
 * END HEADER
 */

import { computed } from 'vue'
import { trans } from '@common/i18n-renderer'
import IrisIndicator from '@common/vue/IrisIndicator.vue'
import RingProgress from '@common/vue/window/toolbar-controls/RingProgress.vue'
import { useLRTStore } from 'source/pinia'
import { TaskStatus } from 'source/pinia/lrt-store'

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
}>()

const lrtStore = useLRTStore()

const pomodoroLabel = trans('Pomodoro timer')
const updateLabel = trans('Update available')

const tasks = computed(() => lrtStore.tasks)

function taskCount (status: TaskStatus): number {
  return tasks.value.filter(task => task.status === status).length
}
</script>

<style lang="less">
body .main-statusbar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: flex-end;
  height: 26px;
  padding: 0 var(--chrome-inset);
  box-sizing: border-box;
  border-top: 1px solid var(--chrome-border);
  background-color: var(--chrome-surface);
  color: var(--chrome-text-muted);
  font-size: var(--chrome-section-font-size);

  .main-statusbar-group {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 100%;
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
    cursor: pointer;

    &:hover {
      background-color: var(--chrome-row-hover-bg);
    }

    cds-icon {
      width: 14px;
      height: 14px;
    }
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
