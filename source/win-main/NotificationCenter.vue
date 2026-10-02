<template>
  <button
    type="button"
    class="main-statusbar-item"
    data-statusbar-item="notifications"
    v-bind:title="toggleTitle"
    v-bind:aria-label="toggleTitle"
    v-bind:aria-pressed="open"
    v-on:click="setOpen(!open)"
  >
    <cds-icon
      shape="bell"
      role="presentation"
    ></cds-icon>
    <span
      v-if="entries.length > 0"
      class="notification-count"
      data-notification-count
    >{{ entries.length }}</span>
  </button>
  <Teleport to="body">
    <section
      v-if="open"
      id="notification-center"
      role="dialog"
      v-bind:aria-label="panelTitle"
    >
      <header>
        <span class="notification-center-title">{{ panelTitle }}</span>
        <button
          type="button"
          data-notification-dismiss-all
          v-bind:disabled="entries.length === 0"
          v-on:click="dismissAllNotifications()"
        >
          {{ dismissAllLabel }}
        </button>
        <button
          type="button"
          v-bind:aria-label="closeLabel"
          v-on:click="setOpen(false)"
        >
          <cds-icon
            shape="times"
            role="presentation"
          ></cds-icon>
        </button>
      </header>
      <p
        v-if="entries.length === 0"
        class="notification-center-empty"
      >
        {{ emptyLabel }}
      </p>
      <ol v-else>
        <li
          v-for="entry in newestFirst"
          v-bind:key="entry.id"
          v-bind:class="['notification-entry', entry.kind]"
        >
          <time v-bind:datetime="entry.time.toISOString()">{{ entry.time.toLocaleTimeString() }}</time>
          <span class="notification-message">{{ entry.message }}</span>
          <span class="notification-controls">
            <button
              v-if="entry.kind === 'error'"
              type="button"
              data-notification-copy
              v-on:click="copyNotificationText(entry.message, $event.currentTarget as HTMLButtonElement)"
            >
              Copy
            </button>
            <button
              v-if="entry.action !== undefined"
              type="button"
              data-notification-action
              v-on:click="runNotificationAction(entry.id)"
            >
              {{ entry.action.label }}
            </button>
            <button
              type="button"
              aria-label="Dismiss"
              v-on:click="dismissNotification(entry.id)"
            >
              <cds-icon
                shape="times"
                role="presentation"
              ></cds-icon>
            </button>
          </span>
        </li>
      </ol>
    </section>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        NotificationCenter
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The status bar's notification item and the panel it
 *                  opens. The item shows the number of messages in the
 *                  notification log (show-toast.ts); the panel lists them,
 *                  newest first, with their time, text, Copy for errors,
 *                  the action button and a per-message dismiss, and it
 *                  dismisses all messages at once. Escape or the item
 *                  closes the panel.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import {
  copyNotificationText,
  dismissAllNotifications,
  dismissNotification,
  type NotificationEntry,
  notificationEntries,
  onNotificationsChanged,
  runNotificationAction,
  setNotificationCenterOpen,
} from "@common/util/show-toast";
import { computed, onBeforeUnmount, ref, shallowRef } from "vue";

const toggleTitle = trans("Notifications");
const panelTitle = trans("Notifications");
const dismissAllLabel = trans("Dismiss all");
const closeLabel = trans("Close");
const emptyLabel = trans("No notifications");

const entries = shallowRef<readonly NotificationEntry[]>([...notificationEntries()]);
const open = ref(false);
const newestFirst = computed(() => [...entries.value].reverse());

const unsubscribe = onNotificationsChanged(() => {
  entries.value = [...notificationEntries()];
});
onBeforeUnmount(unsubscribe);

function closeOnEscape(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    setOpen(false);
  }
}

function setOpen(value: boolean): void {
  open.value = value;
  setNotificationCenterOpen(value);
  if (value) {
    window.addEventListener("keydown", closeOnEscape);
  } else {
    window.removeEventListener("keydown", closeOnEscape);
  }
}

onBeforeUnmount(() => {
  window.removeEventListener("keydown", closeOnEscape);
});
</script>

<style lang="less">
body .main-statusbar .notification-count {
  min-width: 14px;
  padding: 0 4px;
  border-radius: 7px;
  background-color: var(--chrome-text-muted);
  color: var(--chrome-surface);
  font-size: 10px;
  line-height: 14px;
  text-align: center;
}

body #notification-center {
  position: fixed;
  right: 16px;
  bottom: 36px;
  z-index: 1001;
  display: flex;
  flex-direction: column;
  width: min(600px, calc(100vw - 32px));
  max-height: 60vh;
  border: 1px solid var(--chrome-border);
  border-radius: 8px;
  background-color: var(--chrome-surface);
  color: var(--chrome-text);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .25);
  font: 13px/1.4 system-ui, sans-serif;

  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--chrome-border);
  }

  .notification-center-title {
    flex: 1 1 auto;
    font-weight: 600;
  }

  button {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border: 1px solid var(--chrome-border);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;

    &:hover:not(:disabled) {
      background-color: var(--chrome-row-hover-bg);
    }

    &:disabled {
      opacity: .5;
      cursor: default;
    }
  }

  .notification-center-empty {
    margin: 0;
    padding: 16px;
    color: var(--chrome-text-muted);
  }

  ol {
    margin: 0;
    padding: 0;
    overflow: auto;
    list-style: none;
  }

  .notification-entry {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--chrome-border);
    user-select: text;

    &.error {
      border-left: 3px solid #c0584b;
    }
  }

  time {
    flex: 0 0 auto;
    color: var(--chrome-text-muted);
    font-variant-numeric: tabular-nums;
  }

  .notification-message {
    flex: 1 1 auto;
    min-width: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .notification-controls {
    display: flex;
    flex: 0 0 auto;
    gap: 6px;
  }
}
</style>
