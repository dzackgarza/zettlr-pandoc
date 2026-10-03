<template>
  <PopoverWrapper v-bind:target="props.target">
    <ButtonControl
      v-if="hasFinishedTasks"
      v-bind:label="clearLabel"
      v-on:click="clearFinishedTasks"
    ></ButtonControl>
    <div id="lrt-wrapper">
      <div
        v-for="task in sortedTasks"
        v-bind:key="task.id"
        v-bind:class="{
          lrt: true,
          'in-progress': task.status === TaskStatus.ongoing,
          error: task.status === TaskStatus.error,
          aborted: task.status === TaskStatus.aborted,
          interactable: task.interactable
        }"
        v-on:click="interactTask(task.id)"
      >
        <h4 class="title">
          {{ task.title }}
        </h4>
        <div v-if="task.info" class="info">
          <span v-if="task.status !== TaskStatus.error">
            {{ task.info }}
          </span>
          <span v-if="task.error !== undefined">
            {{ task.error.name + ': ' + task.error.message }}
          </span>
        </div>
        <TaskProgressIndicator
          v-if="task.status === TaskStatus.ongoing"
          class="progress"
          :label="task.title"
          :percentage="task.currentTaskPercentage"
        />
        <div
          v-else
          class="status"
        >
          <template v-if="task.status === TaskStatus.error">
            <cds-icon shape="exclamation-triangle"></cds-icon>
          </template>
          <template v-else-if="task.status === TaskStatus.finished">
            <cds-icon shape="check"></cds-icon>
          </template>
          <template v-else-if="task.status === TaskStatus.aborted">
            <cds-icon shape="times"></cds-icon>
          </template>
        </div>
      </div>
    </div>
  </PopoverWrapper>
</template>

<script setup lang="ts">
import type { LRTIPCSyncMessage } from "source/app/service-providers/long-running-tasks";
import type { LRT_JSON } from "source/app/service-providers/long-running-tasks/task";
import { trans } from "source/common/i18n-renderer";
import ButtonControl from "source/common/vue/form/elements/ButtonControl.vue";
import PopoverWrapper from "source/common/vue/PopoverWrapper.vue";
import TaskProgressIndicator from "source/common/vue/TaskProgressIndicator.vue";
import { useLRTStore } from "source/pinia";
import { TaskStatus } from "source/pinia/lrt-store";
import { computed } from "vue";

const ipcRenderer = window.ipc;

const clearLabel = trans("Clear finished tasks");

const props = defineProps<{ target: HTMLElement }>();
const LRTStore = useLRTStore();

const sortedTasks = computed<LRT_JSON[]>(() => {
  return LRTStore.tasks.toSorted((a, b) => {
    // First sorting: after status
    const aOngoing = a.status === TaskStatus.ongoing ? 1 : 0;
    const bOngoing = b.status === TaskStatus.ongoing ? 1 : 0;
    const cmpResult = aOngoing - bOngoing;

    if (cmpResult !== 0) {
      return cmpResult;
    }

    // Next sorting: time
    return a.startTime.localeCompare(b.startTime);
  });
});

const hasFinishedTasks = computed(() => {
  return LRTStore.tasks.some((t) => t.status !== TaskStatus.ongoing);
});

function clearFinishedTasks() {
  const finishedTasks = LRTStore.tasks.filter((t) => t.status !== TaskStatus.ongoing);

  for (const task of finishedTasks) {
    LRTStore.deleteTask(task.id);
  }
}

function interactTask(id: string) {
  ipcRenderer.send("lrt-provider", {
    command: "interact-task",
    payload: { id },
  } as LRTIPCSyncMessage);
}
</script>


<style lang="css" scoped>
#lrt-wrapper {
  display: flex;
  flex-direction: column;
  gap: 5px;

  .lrt {
    min-width: 200px;
    display: grid;
    padding: 5px;
    border: 1px solid var(--chrome-border);
    border-radius: 5px;
    grid-template-areas: "title status" "info info" "progress progress";
    grid-template-columns: minmax(0, 1fr) 24px;
    gap: 5px;
    background-color: var(--chrome-surface);
    color: var(--chrome-text);

    &.interactable { cursor: pointer; }

    &.error {
      border-left: 3px solid var(--accent-red);
    }

    &.in-progress {
      border-left: 3px solid var(--chrome-row-accent);
    }

    &.aborted {
      opacity: 0.7;
    }

    .title {
      grid-area: title;
      font-size: 1em;
      color: inherit;
    }

    .info {
      grid-area: info;
      font-size: 0.8em;

      color: var(--chrome-text-muted);
    }

    .progress {
      grid-area: progress;
    }

    .status {
      grid-area: status;
      text-align: right;
    }
  }
}

</style>
