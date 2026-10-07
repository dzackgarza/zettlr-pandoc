<template>
  <section
    class="keybindings-editor"
    aria-labelledby="keybindings-title"
  >
    <header class="keybindings-toolbar">
      <div>
        <h1 id="keybindings-title">
          {{ title }}
        </h1>
        <p>{{ summary }}</p>
      </div>
      <label class="keybindings-search">
        <span class="sr-only">{{ searchLabel }}</span>
        <input
          v-model="query"
          data-keybindings-search
          type="search"
          :placeholder="searchPlaceholder"
        >
      </label>
    </header>

    <div
      data-keybindings-table
      class="keybindings-table"
      role="table"
    >
      <div
        class="keybindings-row keybindings-header"
        role="row"
      >
        <span role="columnheader">{{ commandLabel }}</span>
        <span role="columnheader">{{ keybindingLabel }}</span>
        <span role="columnheader">{{ whenLabel }}</span>
        <span role="columnheader">{{ sourceLabel }}</span>
        <span role="columnheader"><span class="sr-only">{{ actionsLabel }}</span></span>
      </div>

      <div
        v-for="command in filteredCommands"
        :key="command.id"
        data-keybinding-row
        :data-command-id="command.id"
        :name="configPath(command)"
        :class="{ conflict: conflicts(command.id).length > 0 }"
        class="keybindings-row"
        role="row"
      >
        <span
          class="command-cell"
          role="cell"
        >
          <strong>{{ trans(command.label) }}</strong>
          <code>{{ command.id }}</code>
        </span>
        <span
          class="keybinding-cell"
          role="cell"
        >
          <input
            v-if="editingCommand === command.id"
            ref="captureInputs"
            data-keybinding-capture
            class="keybinding-capture"
            readonly
            :value="captureText"
            :aria-label="captureLabel"
            @keydown.prevent.stop="captureKeybinding"
          >
          <ShortcutDisplay
            v-else-if="resolvedShortcut(command.id) !== undefined"
            :shortcut="
              explodeShortcut(resolvedShortcut(command.id) ?? '')
            "
            display="full"
          />
          <span
            v-else
            class="unassigned"
          >{{ unassignedLabel }}</span>
          <span
            v-if="conflicts(command.id).length > 0"
            class="conflict-indicator"
            :title="conflictMessage(command.id)"
            aria-label="Shortcut conflict"
          >!</span>
        </span>
        <code
          class="when-cell"
          role="cell"
        >{{ command.when }}</code>
        <span
          class="source-cell"
          role="cell"
        >{{ sourceFor(command) }}</span>
        <span
          class="actions-cell"
          role="cell"
        >
          <button
            data-edit-keybinding
            type="button"
            :aria-label="`${editLabel}: ${trans(command.label)}`"
            :title="editLabel"
            @click="startEditing(command.id)"
          >
            ✎
          </button>
          <button
            data-reset-keybinding
            type="button"
            :disabled="!isUserBinding(command)"
            :aria-label="`${resetLabel}: ${trans(command.label)}`"
            :title="resetLabel"
            @click="resetBinding(command)"
          >
            ↺
          </button>
        </span>
      </div>

      <p
        v-if="filteredCommands.length === 0"
        class="empty-results"
      >
        {{ noResultsLabel }}
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
import {
  type CommandId,
  type CommandRegistration,
  commandRegistry,
  getCommandConflicts,
  getConfiguredShortcut,
} from "@common/commands/command-registry";
import { trans } from "@common/i18n-renderer";
import { type ExplodedShortcut, explodeShortcut, implodeShortcut } from "@common/util/shortcuts";
import ShortcutDisplay from "@common/vue/ShortcutDisplay.vue";
import { useConfigStore } from "source/pinia";
import { computed, nextTick, ref } from "vue";
import { base, keyName } from "w3c-keyname";

const configStore = useConfigStore();
const query = ref("");
const editingCommand = ref<CommandId>();
const capturedShortcut = ref("");
const captureInputs = ref<HTMLInputElement[]>([]);

const title = trans("Keyboard Shortcuts");
const summary = trans("Change the keys that run registered commands.");
const searchLabel = trans("Search keyboard shortcuts");
const searchPlaceholder = trans("Search commands or keybindings");
const commandLabel = trans("Command");
const keybindingLabel = trans("Keybinding");
const whenLabel = trans("When");
const sourceLabel = trans("Source");
const actionsLabel = trans("Actions");
const editLabel = trans("Edit");
const resetLabel = trans("Reset");
const captureLabel = trans("Press a key combination, then press Enter");
const unassignedLabel = trans("Unassigned");
const noResultsLabel = trans("No matching commands");
const defaultLabel = trans("Default");
const userLabel = trans("User");

const commands = commandRegistry.all();

const filteredCommands = computed(() => {
  const search = query.value.trim().toLowerCase();
  if (search === "") {
    return commands;
  }
  return commands.filter((command) => {
    const shortcut = resolvedShortcut(command.id) ?? "";
    return [command.label, command.id, command.group, command.when, shortcut].some((value) =>
      value.toLowerCase().includes(search),
    );
  });
});

const captureText = computed(() => capturedShortcut.value || captureLabel);

function configuredValue(command: CommandRegistration): string {
  const target =
    command.scope === "editor"
      ? configStore.config.shortcuts.editor
      : configStore.config.shortcuts.ui;
  return target[command.id] ?? "";
}

function resolvedShortcut(id: CommandId): string | undefined {
  return getConfiguredShortcut(id, configStore.config.shortcuts);
}

function conflicts(id: CommandId): CommandId[] {
  return getCommandConflicts(id, configStore.config.shortcuts);
}

function conflictMessage(id: CommandId): string {
  return trans("Conflicts with: %s", conflicts(id).join(", "));
}

function configPath(command: CommandRegistration): string {
  return `shortcuts.${command.scope === "editor" ? "editor" : "ui"}.${command.id}`;
}

function isUserBinding(command: CommandRegistration): boolean {
  return configuredValue(command).trim() !== "";
}

function sourceFor(command: CommandRegistration): string {
  return isUserBinding(command) ? userLabel : defaultLabel;
}

async function startEditing(id: CommandId): Promise<void> {
  editingCommand.value = id;
  capturedShortcut.value = "";
  await nextTick();
  captureInputs.value[0]?.focus();
}

function resetBinding(command: CommandRegistration): void {
  configStore.setConfigFromForm(configPath(command), "");
  if (editingCommand.value === command.id) {
    editingCommand.value = undefined;
  }
}

function captureKeybinding(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    editingCommand.value = undefined;
    capturedShortcut.value = "";
    return;
  }
  const hasModifier = event.altKey || event.shiftKey || event.metaKey || event.ctrlKey;
  if (event.key === "Enter" && !hasModifier && capturedShortcut.value !== "") {
    const command = commands.find((candidate) => candidate.id === editingCommand.value);
    if (command !== undefined && capturedShortcut.value !== "") {
      configStore.setConfigFromForm(configPath(command), capturedShortcut.value);
    }
    editingCommand.value = undefined;
    capturedShortcut.value = "";
    return;
  }

  const isNonTerminalKey = ["Alt", "Shift", "Meta", "Control", "Dead"].includes(event.key);
  if (isNonTerminalKey || event.key === "Unidentified") {
    return;
  }
  const isLayer3 = event.altKey && process.platform !== "win32";
  const key = isLayer3 ? base[event.keyCode] : keyName(event);
  const shortcut: ExplodedShortcut = {
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    modKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    key: event.shiftKey && key !== key.toLowerCase() ? key.toLowerCase() : key,
  };
  capturedShortcut.value = implodeShortcut(shortcut);
}
</script>

<style scoped lang="less">
.keybindings-editor {
  min-width: 0;
  padding: 22px 24px 36px;
}

.keybindings-toolbar {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 18px;

  h1 {
    margin: 0 0 4px;
    font-size: 22px;
    font-weight: 600;
  }

  p {
    margin: 0;
    color: var(--grey-4);
  }
}

.keybindings-search {
  flex: 0 1 360px;

  input {
    box-sizing: border-box;
    width: 100%;
    min-height: 32px;
    padding: 5px 9px;
    border: 1px solid var(--grey-2);
    border-radius: 4px;
    background: transparent;
    color: inherit;

    &:focus {
      border-color: var(--system-accent-color);
      outline: 1px solid var(--system-accent-color);
    }
  }
}

.keybindings-table {
  width: 100%;
  border: 1px solid var(--grey-2);
  border-radius: 6px;
  overflow: hidden;
}

.keybindings-row {
  box-sizing: border-box;
  display: grid;
  grid-template-columns: minmax(145px, 2fr) minmax(100px, 1.2fr) minmax(
      90px,
      1fr
    ) 72px 68px;
  min-height: 46px;
  border-bottom: 1px solid var(--grey-1);

  &:last-of-type {
    border-bottom: 0;
  }

  > [role="cell"],
  > [role="columnheader"] {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    min-width: 0;
    padding: 7px 10px;
  }

  &:not(.keybindings-header):hover {
    background: color-mix(in srgb, var(--grey-1) 45%, transparent);
  }
}

.keybindings-header {
  min-height: 34px;
  background: var(--grey-1);
  color: var(--grey-5);
  font-size: 12px;
  font-weight: 600;
}

.command-cell {
  flex-direction: column;
  align-items: flex-start !important;
  justify-content: center;
  gap: 2px;

  strong {
    overflow: hidden;
    max-width: 100%;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  code {
    color: var(--grey-3);
    font-size: 11px;
  }
}

.keybinding-cell {
  gap: 6px;
}

.keybinding-capture {
  box-sizing: border-box;
  width: 100%;
  min-height: 30px;
  padding: 4px 7px;
  border: 1px solid var(--system-accent-color);
  border-radius: 4px;
  background: transparent;
  color: inherit;
  outline: 1px solid var(--system-accent-color);
}

.unassigned,
.source-cell {
  color: var(--grey-3);
}

.when-cell {
  overflow: hidden;
  color: var(--grey-4);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions-cell {
  justify-content: flex-end;
  gap: 4px;

  button {
    width: 26px;
    height: 26px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    cursor: pointer;

    &:hover:not(:disabled),
    &:focus-visible {
      border-color: var(--grey-2);
      background: var(--grey-1);
    }

    &:disabled {
      opacity: 0.35;
      cursor: default;
    }
  }
}

.conflict-indicator {
  display: inline-grid;
  width: 18px;
  height: 18px;
  place-items: center;
  border-radius: 50%;
  background: #b36b00;
  color: white;
  font-size: 12px;
  font-weight: 700;
}

.empty-results {
  margin: 0;
  padding: 36px;
  text-align: center;
  color: var(--grey-3);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 900px) {
  .keybindings-editor {
    overflow-x: auto;
    padding: 16px;
  }

  .keybindings-toolbar {
    align-items: stretch;
    flex-direction: column;
    gap: 12px;
  }

  .keybindings-search {
    flex-basis: auto;
  }
}
</style>
