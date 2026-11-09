<template>
  <DialogRoot v-model:open="editing">
    <DialogPortal>
      <DialogOverlay class="ignore-rules-backdrop"></DialogOverlay>
      <DialogContent class="ignore-rules-dialog" data-ignore-rules-dialog>
        <DialogTitle class="ignore-rules-title">{{ trans('File filters') }}</DialogTitle>
        <DialogDescription class="ignore-rules-body">
          {{ trans('Every setting that decides which files and folders the app lists. A path that these settings hide is not in the file manager, the launcher, search, links or lint.') }}
        </DialogDescription>
        <div class="ignore-rules-sources">
          <label class="ignore-rules-toggle">
            <input v-model="showIgnoredDraft" type="checkbox" data-ignore-rules-show-ignored>
            <span>
              <span class="ignore-rules-heading">{{ trans('Turn the filters off') }}</span>
              <span class="ignore-rules-note">{{ trans('No rule hides a file or folder anywhere in the app. The file manager dims each match.') }}</span>
            </span>
          </label>

          <section class="ignore-rules-section">
            <h3 class="ignore-rules-heading">{{ trans('File types') }}</h3>
            <label class="ignore-rules-source">
              <span>{{ trans('Show only these extensions (one on each line; no line shows every type)') }}</span>
              <textarea
                v-model="includeDraft"
                class="ignore-rules-input"
                rows="4"
                spellcheck="false"
                data-ignore-rules-include
              ></textarea>
            </label>
            <div class="ignore-rules-types">
              <label v-for="[key, label] in FILE_TYPES" v-bind:key="key" class="ignore-rules-toggle">
                <input v-model="typeDrafts[key]" type="checkbox" v-bind:data-ignore-rules-type="key">
                <span>{{ label }}</span>
              </label>
            </div>
            <label class="ignore-rules-source">
              <span>{{ trans('Show these other extensions too (one on each line)') }}</span>
              <textarea
                v-model="attachmentDraft"
                class="ignore-rules-input"
                rows="2"
                spellcheck="false"
                data-ignore-rules-attachments
              ></textarea>
            </label>
          </section>

          <section class="ignore-rules-section">
            <h3 class="ignore-rules-heading">{{ trans('Rules') }}</h3>
            <label class="ignore-rules-source">
              <span>{{ trans('All workspaces') }}</span>
              <textarea
                v-model="globalDraft"
                class="ignore-rules-input"
                rows="5"
                spellcheck="false"
                data-ignore-rules-global
              ></textarea>
            </label>
            <label
              v-for="root in roots"
              v-bind:key="root"
              class="ignore-rules-source"
            >
              <span v-bind:title="root">
                {{ pathBasename(root) }}
                <span class="ignore-rules-file">{{ WORKSPACE_RULES_FILE }}</span>
              </span>
              <textarea
                v-model="workspaceDrafts[root]"
                class="ignore-rules-input"
                rows="5"
                spellcheck="false"
                v-bind:data-ignore-rules-workspace="root"
              ></textarea>
            </label>
            <table class="ignore-rules-syntax">
              <tbody>
                <tr v-for="[rule, meaning] in SYNTAX" v-bind:key="rule">
                  <td><code>{{ rule }}</code></td>
                  <td>{{ meaning }}</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section v-if="projects.length > 0" class="ignore-rules-section">
            <h3 class="ignore-rules-heading">{{ trans('Project files') }}</h3>
            <span class="ignore-rules-note">{{ trans('Which files of a project the file manager lists. Folders stay listed.') }}</span>
            <label
              v-for="project in projects"
              v-bind:key="project.path"
              class="ignore-rules-project"
              v-bind:title="project.path"
            >
              <span>{{ project.name }}</span>
              <select v-model="projectDrafts[project.path]" v-bind:data-ignore-rules-project="project.path">
                <option value="all">{{ trans('All files') }}</option>
                <option value="included">{{ trans('Included files') }}</option>
                <option value="omitted">{{ trans('Omitted files') }}</option>
              </select>
            </label>
          </section>

          <section class="ignore-rules-section">
            <h3 class="ignore-rules-heading">{{ trans('Always hidden') }}</h3>
            <span class="ignore-rules-note">{{ trans('The app never lists symbolic links or these names:') }}</span>
            <code class="ignore-rules-builtin">{{ BUILT_IN.join('  ') }}</code>
          </section>
        </div>
        <div class="ignore-rules-actions">
          <DialogClose class="ignore-rules-button">{{ trans('Cancel') }}</DialogClose>
          <button
            class="ignore-rules-button ignore-rules-button-primary"
            data-ignore-rules-save
            v-on:click="save()"
          >
            {{ trans('Save') }}
          </button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        IgnoreRulesDialog
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The one editor of every setting that decides which files
 *                  and folders the app lists: the reveal toggle, the file
 *                  types, the rules for all workspaces, the rules file of
 *                  each open workspace, the project file filter of each
 *                  project, and the read-only built-in names. Save sends
 *                  each changed value to its owner.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import { reportError } from "@common/util/error-reporting";
import { pathBasename } from "@common/util/renderer-path-polyfill";
import showToast from "@common/util/show-toast";
import type { ConfigPath, ConfigValue } from "@providers/config/get-config-template";
import { storeToRefs } from "pinia";
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui";
import { IGNORE_PATHS } from "source/common/util/ignore-path";
import { rulesTextOf, WORKSPACE_RULES_FILE } from "source/common/util/ignore-rules";
import { useConfigStore, useIgnoreRulesStore, useWorkspaceStore } from "source/pinia";
import type { DirDescriptor, ProjectFileFilter } from "source/types/common/fsal";
import { computed, ref, watch } from "vue";
import { updateExplorerDirectory } from "./file-manager/util/update-explorer-directory";

const ipcRenderer = window.ipc;

const SYNTAX: ReadonlyArray<[rule: string, meaning: string]> = [
  ["*scripts*", trans("Each file and folder with “scripts” in its name")],
  ["*_files/", trans("Each folder with a name that ends in “_files”")],
  ["references/", trans("Each folder with the name “references”")],
  ["AGENTS.md", trans("Each file and folder with the name “AGENTS.md”")],
  ["/drafts/old/", trans("The one folder “drafts/old” at the workspace root")],
  ["!keep.md", trans("Shows “keep.md” again, but not below a hidden folder")],
];

type FileTypeKey = "images" | "pdf" | "msoffice" | "openOffice" | "dataFiles" | "dotFiles";

const FILE_TYPES: ReadonlyArray<[key: FileTypeKey, label: string]> = [
  ["images", trans("Images")],
  ["pdf", trans("PDF documents")],
  ["msoffice", trans("MS Office Documents")],
  ["openOffice", trans("Open Office Documents")],
  ["dataFiles", trans("Data files (tsv, csv, etc.)")],
  ["dotFiles", trans("Dot Files and Folders")],
];

/** The names in IGNORE_PATHS, written without their RegExp escapes. */
const BUILT_IN = IGNORE_PATHS.map((pattern) => pattern.replaceAll("\\", ""));

const configStore = useConfigStore();
const workspaceStore = useWorkspaceStore();
const { sources, editing } = storeToRefs(useIgnoreRulesStore());

const roots = computed(() => [...sources.value.workspaceRules.keys()]);
const projects = computed<DirDescriptor[]>(() =>
  [...workspaceStore.descriptorMap.values()]
    .filter((descriptor): descriptor is DirDescriptor => descriptor.type === "directory")
    .filter((directory) => directory.settings.project !== null),
);

const showIgnoredDraft = ref(false);
const includeDraft = ref("");
const typeDrafts = ref<Record<FileTypeKey, boolean>>({
  images: true,
  pdf: true,
  msoffice: true,
  openOffice: true,
  dataFiles: true,
  dotFiles: false,
});
const attachmentDraft = ref("");
const globalDraft = ref("");
const workspaceDrafts = ref<Record<string, string>>({});
const projectDrafts = ref<Record<string, ProjectFileFilter>>({});

watch(editing, (isOpen) => {
  if (!isOpen) {
    return;
  }
  const { config } = configStore;
  showIgnoredDraft.value = config.fileManager.showIgnored;
  includeDraft.value = config.fileManager.filters.include.join("\n");
  for (const [key] of FILE_TYPES) {
    typeDrafts.value[key] = config.files[key].showInFilemanager;
  }
  attachmentDraft.value = config.attachmentExtensions.join("\n");
  globalDraft.value = sources.value.globalRules.join("\n");
  workspaceDrafts.value = Object.fromEntries(sources.value.workspaceRules);
  projectDrafts.value = Object.fromEntries(
    projects.value.map((project) => [project.path, project.settings.explorer.projectFilter]),
  );
});

function linesOf(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function setIfChanged<P extends ConfigPath>(
  key: P,
  next: ConfigValue<P>,
  current: ConfigValue<P>,
): void {
  if (JSON.stringify(next) !== JSON.stringify(current)) {
    configStore.setConfigValue(key, next);
  }
}

/** The text of a rules file: no text when it holds no line, else one final line end. */
function fileTextOf(draft: string): string {
  const text = draft.replace(/\s+$/, "");
  return text === "" ? "" : `${text}\n`;
}

function save(): void {
  const { config } = configStore;
  setIfChanged("fileManager.showIgnored", showIgnoredDraft.value, config.fileManager.showIgnored);
  setIfChanged(
    "fileManager.filters.include",
    linesOf(includeDraft.value),
    config.fileManager.filters.include,
  );
  for (const [key] of FILE_TYPES) {
    setIfChanged(
      `files.${key}.showInFilemanager`,
      typeDrafts.value[key],
      config.files[key].showInFilemanager,
    );
  }
  setIfChanged("attachmentExtensions", linesOf(attachmentDraft.value), config.attachmentExtensions);
  setIfChanged(
    "fileManager.ignoreRules",
    linesOf(globalDraft.value),
    config.fileManager.ignoreRules,
  );

  const changedRules = roots.value
    .map((root) => ({ root, text: fileTextOf(workspaceDrafts.value[root]) }))
    .filter(
      ({ root, text }) => text !== fileTextOf(rulesTextOf(sources.value.workspaceRules, root)),
    );
  const changedProjects = projects.value.filter(
    (project) => projectDrafts.value[project.path] !== project.settings.explorer.projectFilter,
  );

  Promise.all([
    ...changedRules.map(async (payload) => {
      await ipcRenderer.invoke("fsal", { command: "set-workspace-ignore-rules", payload });
    }),
    ...changedProjects.map((project) =>
      updateExplorerDirectory(project, () => ({}), {
        projectFilter: projectDrafts.value[project.path],
      }),
    ),
  ])
    .then(() => {
      editing.value = false;
    })
    .catch((err) => {
      reportError("Could not save the file filters", err);
      showToast(
        trans("Could not save the filters: %s", err instanceof Error ? err.message : String(err)),
        "error",
      );
    });
}
</script>

<style lang="less">
.ignore-rules-backdrop {
  position: fixed;
  inset: 0;
  background-color: var(--chrome-overlay);
}

.ignore-rules-dialog {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 600px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  padding: 16px;
  border-radius: 8px;
  background-color: var(--chrome-surface);
  box-shadow: var(--chrome-elevation);
  color: var(--chrome-text);
  font-size: var(--chrome-font-size);

  .ignore-rules-title { margin: 0; font-size: 15px; font-weight: 600; }
  .ignore-rules-body { margin: 0; color: var(--chrome-text-muted); }

  .ignore-rules-sources {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
    overflow-y: auto;
  }

  .ignore-rules-source {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .ignore-rules-heading { margin: 0; font-size: inherit; font-weight: 600; }
  .ignore-rules-note { display: block; color: var(--chrome-text-muted); }

  .ignore-rules-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 8px;
    border-top: 1px solid var(--chrome-border);
  }

  .ignore-rules-toggle {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .ignore-rules-types {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 4px 12px;
  }

  .ignore-rules-project {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }

  .ignore-rules-builtin {
    font-family: monospace;
    word-break: break-word;
  }

  .ignore-rules-file {
    margin-left: 6px;
    font-weight: 400;
    color: var(--chrome-text-muted);
  }

  // Three classes outrank the platform rules for every input in
  // generic.css (body.<platform>.dark textarea).
  .ignore-rules-sources textarea.ignore-rules-input {
    box-sizing: border-box;
    width: 100%;
    margin: 0;
    padding: 6px 8px;
    border: 1px solid var(--chrome-input-border);
    border-radius: 6px;
    background-color: var(--chrome-input-bg);
    color: inherit;
    font-family: monospace;
    font-size: inherit;
    line-height: 1.5;
    resize: vertical;

    &:focus-visible {
      outline: 2px solid var(--chrome-row-accent);
      outline-offset: -1px;
    }
  }

  .ignore-rules-syntax {
    border-collapse: collapse;
    color: var(--chrome-text-muted);

    td { padding: 1px 0; vertical-align: baseline; }
    td:first-child { padding-right: 16px; white-space: nowrap; }
    code { color: var(--chrome-text); font-family: monospace; }
  }

  .ignore-rules-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }

  .ignore-rules-actions button.ignore-rules-button {
    appearance: none;
    margin: 0;
    padding: 5px 12px;
    border: 1px solid var(--chrome-border);
    border-radius: 6px;
    background-color: var(--chrome-surface);
    color: inherit;
    font: inherit;
    cursor: pointer;

    &.ignore-rules-button-primary {
      border-color: transparent;
      background-color: var(--chrome-row-accent);
      color: var(--chrome-row-accent-contrast, white);
    }
  }
}
</style>
