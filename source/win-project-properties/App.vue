<template>
  <WindowChrome
    :title="windowTitle"
    :titlebar="true"
    :menubar="false"
    :disable-vibrancy="!hasVibrancy"
    :show-tabbar="true"
    :tabbar-tabs="tabs"
    :tabbar-label="'Properties'"
    @tab="currentTab = $event"
  >
    <!-- Without the settings of the folder, no field takes a change. -->
    <ZtrAdmonition
      v-if="loadFailure !== null"
      type="error"
      class="load-failure"
      style="margin: 10px"
    >
      {{ loadFailure }}
    </ZtrAdmonition>
    <div
      v-show="settingsLoaded && currentTab === 0"
      id="formats-panel"
      role="tabpanel"
    >
      <!-- Add the project title field -->
      <TextControl
        v-model="projectSettings.title"
        :label="projectTitleLabel"
      />

      <!-- Then the CSL file -->
      <FileControl
        v-model="projectSettings.cslStyle"
        :label="cslStyleLabel"
        :reset="true"
        :filter="[{ extensions: ['csl'], name: 'CSL Stylesheet' }]"
      />
      <!-- Also, the other possible files users can override -->
      <FileControl
        v-model="projectSettings.templates.tex"
        :label="texTemplateLabel"
        :reset="true"
        :filter="[{ extensions: ['tex'], name: 'LaTeX Source' }]"
      />
      <FileControl
        v-model="projectSettings.templates.html"
        :label="htmlTemplateLabel"
        :reset="true"
        :filter="[{ extensions: [ 'html', 'htm' ], name: 'HTML Template' }]"
      />
    </div>
    <div
      v-show="settingsLoaded && currentTab === 1"
      id="profiles-panel"
      role="tabpanel"
    >
      <ZtrAdmonition
        v-if="projectSettings.profiles.length === 0"
        style="margin: 10px 0"
      >
        {{ projectBuildWarning }}
      </ZtrAdmonition>

      <ListControl
        :label="exportFormatLabel"
        :value-type="'record'"
        :model-value="(exportFormatList as any[])"
        :column-labels="[exportFormatUseLabel, exportFormatNameLabel, conversionLabel]"
        :key-names="['selected', 'name', 'conversion']"
        :editable="[0]"
        :striped="true"
        @update:model-value="selectExportProfile($event)"
      />
    </div>
    <div
      v-show="settingsLoaded && currentTab === 2"
      id="files-panel"
      role="tabpanel"
    >
      <!-- First, the files to be included in the export -->
      <p>{{ exportFilesLabel }}</p>

      <div
        v-if="missingFiles.length > 0"
        class="export-file-list"
      >
        <ZtrAdmonition>{{ missingFilesMessage }}</ZtrAdmonition>
        <div
          v-for="file in missingFiles"
          :key="file"
          class="export-file-item"
        >
          <button
            class="remove-button"
            :aria-label="removeButtonTitle"
            :title="removeButtonTitle"
            @click="removeFileFromExportList(file)"
          >
            &nbsp;&ndash;&nbsp;
          </button>
          <span>
            {{ file }}
          </span>
        </div>
      </div>

      <ZtrAdmonition
        v-if="projectSettings.files.length === 0"
        style="margin: 10px 0"
      >
        {{ noFilesSelectedMessage }}
      </ZtrAdmonition>

      <div class="export-file-list">
        <div
          v-for="(file, i) in exportFileList"
          :key="file.displayName"
          :class="{ 'export-file-item': true, active: file.included }"
        >
          <div class="actions">
            <template v-if="file.included">
              <button
                class="remove-button"
                :aria-label="removeButtonTitle"
                :title="removeButtonTitle"
                @click="removeFileFromExportList(file.relativePath)"
              >
                &nbsp;&ndash;&nbsp;
              </button>
              <button
                v-if="i > 0"
                class="up-button"
                :aria-label="upButtonTitle"
                :title="upButtonTitle"
                @click="moveFileUpInExportList(file.relativePath)"
              >
                &nbsp;&uarr;&nbsp;
              </button>
              <button
                v-if="i < projectSettings.files.length - 1"
                class="down-button"
                :aria-label="downButtonTitle"
                :title="downButtonTitle"
                @click="moveFileDownInExportList(file.relativePath)"
              >
                &nbsp;&darr;&nbsp;
              </button>
            </template>
            <button
              v-else
              class="add-button"
              :aria-label="addButtonTitle"
              :title="addButtonTitle"
              @click="addFileToExportList(file.relativePath)"
            >
              &nbsp;+&nbsp;
            </button>
          </div>
          <div class="display-name">
            <span>
              {{ file.displayName }}
            </span>
            <span class="relative-dirname">
              {{ file.relativePath }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </WindowChrome>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Project Properties
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This component displays the project properties.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import { SUPPORTED_READERS } from "@common/pandoc-util/pandoc-maps";
import { reportError } from "@common/util/error-reporting";
import { remoteErrorMessage } from "@common/util/ipc-rejection";
import showToast from "@common/util/show-toast";
import FileControl from "@common/vue/form/elements/FileControl.vue";
import ListControl from "@common/vue/form/elements/ListControl.vue";
import TextControl from "@common/vue/form/elements/TextControl.vue";
import WindowChrome from "@common/vue/window/WindowChrome.vue";
import { type WindowTab } from "@common/vue/window/WindowTabbar.vue";
import ZtrAdmonition from "@common/vue/ZtrAdmonition.vue";
import type { CodeFileDescriptor, MDFileDescriptor, ProjectSettings } from "@dts/common/fsal";
import type { ExportItem, ExportItemEntry } from "@providers/commands/exporter/export-items";
import {
  describeResolvedExport,
  type ResolvedExport,
} from "@providers/commands/exporter/resolve-export";
import { parseReaderWriter } from "source/common/pandoc-util/parse-reader-writer";
import { pathToUnix } from "source/common/util/path-to-unix";
import { isInsideRoot } from "source/common/util/renderer-path-polyfill";
import { useConfigStore, useWorkspaceStore } from "source/pinia";
import getDocumentTitle from "source/win-main/util/get-document-title";
import { computed, nextTick, onMounted, ref, watch } from "vue";

const ipcRenderer = window.ipc;

interface ExportProfile {
  selected: boolean;
  name: string;
  conversion: string;
}

const exportFormatLabel = trans("Export project to:");
const exportFormatUseLabel = trans("Use");
const exportFormatNameLabel = trans("Format");
const conversionLabel = trans("Conversion");
const exportFilesLabel = trans("Files to be included in the export");
const projectBuildWarning = trans("Please select at least one profile to build this project.");
const projectTitleLabel = trans("Project Title");
const cslStyleLabel = trans(
  "CSL style of the Pandoc exports of this Project (not the editor, not the PDF recipe)",
);
const texTemplateLabel = trans("LaTeX Template");
const htmlTemplateLabel = trans("HTML Template");
const removeButtonTitle = trans("Remove file from export");
const addButtonTitle = trans("Add file to export");
const upButtonTitle = trans("Move file up");
const downButtonTitle = trans("Move file down");
const noFilesSelectedMessage = trans("You have not selected any files for export.");
const missingFilesMessage = trans(
  "Some files are selected for export but no longer exist in the directory.",
);

const configStore = useConfigStore();
const workspaceStore = useWorkspaceStore();

const hasVibrancy = computed(
  () => configStore.config.window.vibrancy && process.platform === "darwin",
);

const tabs: WindowTab[] = [
  {
    id: "formats-control",
    label: trans("General"),
    icon: "cog",
    controls: "formats-panel",
  },
  {
    id: "profiles-selector",
    label: trans("Profiles"),
    icon: "export",
    controls: "profiles-panel",
  },
  {
    id: "files-control",
    label: "Files",
    icon: "file-settings",
    controls: "formats-panel",
  },
];

const searchParams = new URLSearchParams(window.location.search);
const dirPath = searchParams.get("directory") ?? "";

/**
 * The window has the settings of the Project. Before that it draws no field:
 * a change that the author made in a field would be lost when the settings
 * arrive, and the placeholder settings must not be written.
 */
const settingsLoaded = ref(false);
/** A save of the settings is on its way to the main process. */
let saveInFlight = false;
/**
 * The author changed a setting while a save was on its way. That save
 * carries the settings from before the change, so one more save follows it.
 */
let changedDuringSave = false;
/** Why the window has no settings of the folder: it then takes no change. */
const loadFailure = ref<string | null>(null);
/** The export items of the application (`exporter/export-items.ts`). */
const exportItems = ref<ExportItemEntry[]>([]);
/** What each item runs as an export of this Project, by the identity of the item. */
const resolvedExports = ref<Map<string, ResolvedExport>>(new Map());

const projectSettings = ref<ProjectSettings>({
  manifest: { kind: "zettlr" },
  title: "",
  profiles: [],
  files: [],
  cslStyle: "",
  templates: { tex: "", html: "" },
});

const descriptor = computed(() => workspaceStore.descriptorMap.get(dirPath));

// Holds all available files inside the directory
const availableFiles = computed<Array<MDFileDescriptor | CodeFileDescriptor>>(() => {
  if (descriptor.value === undefined || descriptor.value.type !== "directory") {
    return [];
  }

  const absPath = descriptor.value.path;

  return workspaceStore.pathList
    .filter((p) => isInsideRoot(p, absPath))
    .map((f) => workspaceStore.descriptorMap.get(f))
    .filter((d) => d !== undefined && (d.type === "code" || d.type === "file"));
});

// Returns a list of all files, prepared for enabling the user to add/remove
// files from the export list
const exportFileList = computed(() => {
  const files: Array<{ displayName: string; included: boolean; relativePath: string }> = [];
  const projectFiles = projectSettings.value.files;

  for (const file of availableFiles.value) {
    // The app always defaults to the Unix path conventions (/ instead of \\)
    const relativePath = pathToUnix(file.path.slice(dirPath.length + 1));
    files.push({
      // NOTE: We must map the files to the relative paths from the directory!
      relativePath,
      displayName: getDocumentTitle(file),
      included: projectFiles.includes(relativePath),
    });
  }

  files.sort((a, b) => {
    // Negative if a < b
    const aIdx = projectFiles.indexOf(a.relativePath);
    const bIdx = projectFiles.indexOf(b.relativePath);

    if (aIdx === bIdx) {
      return 0; // Both are -1
    } else if (aIdx < 0 && bIdx > -1) {
      return 1;
    } else if (bIdx < 0 && aIdx > -1) {
      return -1;
    } else {
      // Calculate from the indices
      return aIdx - bIdx;
    }
  });

  return files;
});

// Holds a list of files that are selected for export, but seem to be no longer
// present in the project directory.
const missingFiles = computed(() => {
  const missing: string[] = [];
  const availablePaths = availableFiles.value.map((x) =>
    pathToUnix(x.path.slice(dirPath.length + 1)),
  );

  for (const file of projectSettings.value.files) {
    if (!availablePaths.includes(file)) {
      // This will be passed into "remove" so it needs to be the same as in the original array
      missing.push(file);
    }
  }
  return missing;
});

const currentTab = ref(0);

const windowTitle = computed(() => projectSettings.value.title);

/**
 * The items that a Project can export with: each item that can run, with a
 * reader of Pandoc that the editor writes. A bundle holds one document, so
 * a Project has no bundle.
 */
const offeredItems = computed<ExportItem[]>(() => {
  return exportItems.value
    .filter((item): item is ExportItem => !item.isInvalid)
    .filter((item) => item.engine.kind !== "bundle")
    .filter(
      (item) =>
        item.engine.kind !== "pandoc" ||
        SUPPORTED_READERS.includes(parseReaderWriter(item.engine.reader).name),
    );
});

/**
 * Whether the Project exports with the item. A Project file from before the
 * export items names an export command by its command line.
 */
function isSelected(item: ExportItem): boolean {
  const selected = projectSettings.value.profiles;
  return (
    selected.includes(item.id) ||
    (item.engine.kind === "command" && selected.includes(item.engine.command))
  );
}

/**
 * What an item runs as an export of this Project, for the column of the
 * list: the record of the main process (`resolve-exports`), which an export
 * of the Project makes with the same functions.
 */
function conversionOf(item: ExportItem): string {
  const resolved = resolvedExports.value.get(item.id);
  return resolved === undefined ? "" : describeResolvedExport(resolved).join(" · ");
}

/** Reads what each item runs with the templates and the style of this Project. */
async function resolveExports(): Promise<void> {
  const { templates, cslStyle } = projectSettings.value;
  const resolved: ResolvedExport[] = await ipcRenderer.invoke("assets-provider", {
    command: "resolve-exports",
    payload: {
      project: {
        templates: { tex: templates.tex, html: templates.html },
        cslStyle: typeof cslStyle === "string" ? cslStyle : "",
      },
    },
  });
  resolvedExports.value = new Map(resolved.map((entry) => [entry.item, entry]));
}

const exportFormatList = computed<ExportProfile[]>(() => {
  return offeredItems.value.map((item) => ({
    selected: isSelected(item),
    name: getDisplayText(item.id),
    conversion: conversionOf(item),
  }));
});

watch(projectSettings, updateProperties, { deep: true });

// The list shows what each item runs with the templates and the citation
// style of this Project, so each change of them reads the record again.
watch(
  () => [
    projectSettings.value.templates.tex,
    projectSettings.value.templates.html,
    projectSettings.value.cslStyle,
  ],
  () => {
    resolveExports().catch((err) => reportError(err));
  },
  { immediate: true },
);

// First, we need to get the available export formats
ipcRenderer
  .invoke("assets-provider", { command: "list-export-items" })
  .then((items: ExportItemEntry[]) => {
    exportItems.value = items;
  })
  .catch((err) => reportError(err));

// On startup, fetch the properties immediately
onMounted(() => {
  fetchProperties().catch((failure: Error) => {
    reportError(failure);
    loadFailure.value = trans(
      "Could not load the Project settings: %s",
      remoteErrorMessage(failure),
    );
  });
});

/**
 * Takes the selection of the list. The list gives its rows back in the
 * order of `offeredItems`; the Project stores the identity of each selected
 * item.
 */
function selectExportProfile(newListVal: ExportProfile[]): void {
  projectSettings.value.profiles = offeredItems.value
    .filter((_item, index) => newListVal[index].selected)
    .map((item) => item.id);
}

/** The name of a defaults file without its extension; another name as it is. */
function getDisplayText(name: string): string {
  return /\.ya?ml$/.test(name) ? name.replace(/\.ya?ml$/, "") : name;
}

/** A change that this window does not send: the author gets the cause here. */
function refuseUpdate(message: string): void {
  reportError(message);
  showToast(message, "error", 12000);
}

function updateProperties(): void {
  if (!settingsLoaded.value) {
    return;
  }
  if (saveInFlight) {
    changedDuringSave = true;
    return;
  }

  saveInFlight = true;

  ipcRenderer
    .invoke("fsal", {
      command: "get-descriptor",
      payload: dirPath,
    })
    .then(
      (descriptor) => {
        if (descriptor.type !== "directory") {
          return refuseUpdate(
            trans("Could not update the Project settings: %s is not a folder.", dirPath),
          );
        }

        if (descriptor.settings.project == null) {
          return refuseUpdate(
            trans("Could not update project settings because this folder is no longer a Project."),
          );
        }

        // The JSON round trip de-proxies the reactive settings object.
        const deproxiedSettings = JSON.parse(
          JSON.stringify(projectSettings.value),
        ) as ProjectSettings;

        return ipcRenderer.invoke("application", {
          command: "update-project-properties",
          payload: { properties: deproxiedSettings, path: dirPath },
        });
      },
      // The FSAL is no command: its rejection has no message of its own.
      (failure: Error) => {
        refuseUpdate(
          trans("Could not update the Project settings: %s", remoteErrorMessage(failure)),
        );
      },
    )
    // The dispatcher shows the failure of the command in this window.
    .catch((err) => reportError(err))
    .finally(() => {
      saveInFlight = false;
      if (changedDuringSave) {
        changedDuringSave = false;
        updateProperties();
      }
    });
}

async function fetchProperties(): Promise<void> {
  const descriptor = await ipcRenderer.invoke("fsal", {
    command: "get-descriptor",
    payload: dirPath,
  });
  if (descriptor.type !== "directory") {
    throw new Error(`${dirPath} is not a folder.`);
  }
  // Save the actually used formats.
  if (descriptor.settings.project !== null) {
    projectSettings.value = descriptor.settings.project;
  } else {
    // Apparently the user kept the window open and removed the project
    // state on this project. So let's close this window silently.
    ipcRenderer.send("window-controls", { command: "win-close" });
    return;
  }
  // The watcher of the settings runs for this assignment before the next
  // tick: the settings as they were read are no change, and nothing is sent.
  await nextTick();
  settingsLoaded.value = true;
}

/**
 * Adds the provided file to the list of to-be-exported files in this project.
 *
 * @param   {string}  relativeFilePath  The file path to add
 */
function addFileToExportList(relativeFilePath: string): void {
  if (projectSettings.value.files.includes(relativeFilePath)) {
    return;
  }

  // Will automagically update
  projectSettings.value.files.push(relativeFilePath);
}

/**
 * Removes the provided file from the list of to-be-exported files in this
 * project.
 *
 * @param   {string}  relativeFilePath  The file path to remove
 */
function removeFileFromExportList(relativeFilePath: string): void {
  if (!projectSettings.value.files.includes(relativeFilePath)) {
    return;
  }

  const idx = projectSettings.value.files.indexOf(relativeFilePath);
  projectSettings.value.files.splice(idx, 1);
}

/**
 * Moves the provided file down in the list of to-be-exported files in this
 * project.
 *
 * @param   {string}  relativeFilePath  The file path to move
 */
function moveFileDownInExportList(relativeFilePath: string): void {
  if (!projectSettings.value.files.includes(relativeFilePath)) {
    return;
  }

  const idx = projectSettings.value.files.indexOf(relativeFilePath);
  if (idx === projectSettings.value.files.length - 1) {
    return;
  }

  projectSettings.value.files.splice(idx, 1);
  projectSettings.value.files.splice(idx + 1, 0, relativeFilePath);
}

/**
 * Moves the provided file up in the list of to-be-exported files in this
 * project.
 *
 * @param   {string}  relativeFilePath  The file path to move
 */
function moveFileUpInExportList(relativeFilePath: string): void {
  if (!projectSettings.value.files.includes(relativeFilePath)) {
    return;
  }

  const idx = projectSettings.value.files.indexOf(relativeFilePath);
  if (idx === 0) {
    return;
  }

  projectSettings.value.files.splice(idx, 1);
  projectSettings.value.files.splice(idx - 1, 0, relativeFilePath);
}
</script>

<style lang="less">
div#project-lists p.warning {
  display: flex;
  color: rgb(97, 97, 0);
  background-color: rgb(209, 209, 23);
  border: 1px solid rgb(170, 170, 0);
  border-radius: 5px;
  padding: 5px;
  margin: 5px;

  // More spacing between the icon and the text
  span { padding-left: 5px; }
}

div[role="tabpanel"] {
  overflow: auto; // Enable scrolling, if necessary
  padding: 10px;
  width: 100%;
}

.export-file-list {
  margin: 20px 0 40px 0;

  .export-file-item {
    padding: 5px;
    display: grid;
    grid-template-areas: "actions display-name";
    grid-template-columns: 50px auto;
    column-gap: 20px;

    .display-name {
      grid-area: display-name;
      display: flex;
      flex-direction: column;
      justify-content: center;

      .relative-dirname {
        font-size: 80%;
        color: #ccc;
      }
    }

    .actions {
      grid-area: actions;
      display: grid;
      grid-template-areas: "add-or-remove up-button"
      "add-or-remove down-button";
      grid-template-columns: 50% 50%;
      column-gap: 10px;
      align-items: center;
      justify-content: center;

      .up-button { grid-area: up-button; }
      .down-button { grid-area: down-button; }
      .add-button { grid-area: add-or-remove; }
      .remove-button { grid-area: add-or-remove; }
    }

    &:not(:last-child) {
      border-bottom: 1px solid #ccc;
    }

    &:not(.active) {
      color: #ccc;
    }
  }
}

body.dark .export-file-list {
  .export-file-item {
    .display-name .relative-dirname {
      color: #999;
    }

    &:not(.active) {
      color: #999;
    }

    &:not(:last-child) {
      border-bottom-color: #666;
    }
  }
}
</style>
