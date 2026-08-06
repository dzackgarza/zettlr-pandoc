<template>
  <PopoverWrapper
    :target="target"
    @close="$emit('close')"
  >
    <div class="toolbar-export">
      <h3>Export</h3>
      <p><strong>{{ filename }}</strong></p>
      <SelectControl
        v-model="format"
        :label="formatLabel"
        :options="availableFormats"
      />
      <ExportConfigSummary
        :filters="exportSummary.filters"
        :template="exportSummary.template"
        :data-dir="exportSummary.dataDir"
        :script-info="exportSummary.scriptInfo"
      />
      <!-- The choice of working directory vs. temporary applies to all exporters -->
      <hr>
      <RadioControl
        v-model="exportDirectory"
        :options="{
          'temp': tempDirLabel,
          'cwd': cwdLabel,
          'ask': askLabel
        }"
      />
      <hr>
      <CheckboxControl
        v-model="autoOpenExport"
        :label="autoOpenLabel"
        :name="'open-automatically-checkbox'"
      />
      <!-- Add the exporting button -->
      <button
        ref="exportButton"
        :disabled="isExporting"
        @click="doExport"
      >
        {{ exportButtonLabel }}
      </button>
    </div>
  </PopoverWrapper>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Export Popover
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file enables single-file exports for the user.
 *
 * END HEADER
 */

import PopoverWrapper from '@common/vue/PopoverWrapper.vue'
import RadioControl from '@common/vue/form/elements/RadioControl.vue'
import SelectControl from '@common/vue/form/elements/SelectControl.vue'
import CheckboxControl from '@common/vue/form/elements/CheckboxControl.vue'
import ExportConfigSummary from './ExportConfigSummary.vue'
import { ref, computed, watch, onMounted } from 'vue'
import type { PandocProfileMetadata, ValidPandocProfile } from '@providers/assets'
import { SUPPORTED_READERS } from '@common/pandoc-util/pandoc-maps'
import { trans } from '@common/i18n-renderer'
import { pathBasename } from '@common/util/renderer-path-polyfill'
import { useConfigStore } from 'source/pinia'
import { parseReaderWriter } from 'source/common/pandoc-util/parse-reader-writer'
import type { CustomExportIPCAPI, ExportIPCAPI } from 'source/app/service-providers/commands/export'

const ipcRenderer = window.ipc

const formatLabel = trans('Format')
const autoOpenLabel = trans('Open after export')
const tempDirLabel = trans('Temporary directory')
const cwdLabel = trans('Current directory')
const askLabel = trans('Select directory')

// This is used to limit the number of selected
// profile to filename mappings in the config
const PREVIOUSLY_SELECTED_PROFILE_LIMIT = 50

const exportButton = ref<HTMLButtonElement|null>(null)

ipcRenderer.invoke('assets-provider', { command: 'list-export-profiles' })
  .then((defaults: PandocProfileMetadata[]) => {
    // Save all the exporter information into the array. The computed
    // properties will take the info from that array and re-compute based
    // on the value of "format".
    profileMetadata.value = defaults
    // Get either the last selected exporter for the open file,
    // the last used exporter, or the first element available
    const lastProfile = selectedProfiles.value.find(item => item.filePath === props.filePath)
    const profile = lastProfile ? lastProfile.profile : lastUsedProfile.value

    if (profile in availableFormats.value) {
      format.value = profile
    } else if (exportableProfiles.value.length > 0) {
      format.value = exportableProfiles.value[0].name
    }
  })
  .catch(err => console.error(err))

const configStore = useConfigStore()

const props = defineProps<{
  target: HTMLElement
  filePath: string
}>()

const emit = defineEmits<(e: 'close') => void>()

onMounted(() => {
  exportButton.value?.focus()
})

const isExporting = ref(false)
const format = ref('')
const exportDirectory = ref(configStore.config.export.dir)
const autoOpenExport = ref(configStore.config.export.autoOpenExportedFiles)
const profileMetadata = ref<PandocProfileMetadata[]>([])

const customCommands = computed(() => configStore.config.export.customCommands)
const selectedProfiles = computed(() => configStore.config.export.selectedProfiles)
const lastUsedProfile = computed(() => configStore.config.export.lastUsedProfile)

const exportButtonLabel = computed(() => isExporting.value ? trans('Exporting…') : trans('Export'))
const filename = computed(() => pathBasename(props.filePath))
// Only profiles Zettlr can actually run may be offered for export; an unusable
// one is repaired in the defaults editor, not exported from here.
const exportableProfiles = computed(() => {
  return profileMetadata.value
    .filter((e): e is ValidPandocProfile => !e.isInvalid)
    // Remove files that cannot read any of Zettlr's internal formats
    .filter(e => SUPPORTED_READERS.includes(parseReaderWriter(e.reader).name))
})

const availableFormats = computed(() => {
  const selectOptions: Record<string, string> = {}

  exportableProfiles.value
    .forEach(elem => { selectOptions[elem.name] = getDisplayText(elem) })

  const cmdTitle = trans('command')
  for (const command of customCommands.value) {
    selectOptions[command.command] = `${command.displayName} (${cmdTitle})`
  }

  return selectOptions
})

// Observability: at a glance, what the selected format actually uses.
const exportSummary = computed(() => {
  const profile = exportableProfiles.value.find(p => p.name === format.value)
  const script = configStore.config.export.scripts.find(s => s.name === format.value)
  const customCommand = customCommands.value.find(c => c.command === format.value)
  let scriptInfo = ''
  if (script !== undefined) {
    scriptInfo = `${script.profile} → ${script.command}`
  } else if (customCommand !== undefined) {
    scriptInfo = `raw command: ${customCommand.command}`
  }

  // Effective template: the profile's own, else the configured per-writer default.
  let template = profile?.template ?? ''
  if (template === '' && profile !== undefined) {
    const writer = parseReaderWriter(profile.writer).name
    if ([ 'html', 'html4', 'html5', 'revealjs', 's5', 'slidy', 'dzslides' ].includes(writer)) {
      template = configStore.config.export.htmlTemplate
    } else if ([ 'latex', 'beamer', 'pdf' ].includes(writer)) {
      template = configStore.config.export.latexTemplate
    }
  }

  return {
    filters: configStore.config.export.filters,
    template,
    dataDir: '~/.pandoc',
    scriptInfo
  }
})

watch(autoOpenExport, function (value) {
  // This watcher allows the user to control whether
  // the exported document is automatically opened
  configStore.setConfigValue('export.autoOpenExportedFiles', value)
})

watch(exportDirectory, function (value) {
  // This watcher allows the user to set the export directory from here
  configStore.setConfigValue('export.dir', value)
})

watch(format, function (value) {
  // Remember the last choice
  const prof = exportableProfiles.value.find(e => e.name === value)
  const cmd = customCommands.value.find(x => x.command === value)

  const profile: string  = prof?.name ?? cmd?.command ?? lastUsedProfile.value
  const filePath: string = props.filePath

  const newProfiles = selectedProfiles.value
    // Remove any previous items with the same path
    .filter(item  => item.filePath !== filePath)
    // Clamp the list to the last N - 1 items since we will be pushing one
    .slice(-PREVIOUSLY_SELECTED_PROFILE_LIMIT - 1)

  newProfiles.push({ filePath, profile })

  configStore.setConfigValue('export.selectedProfiles', JSON.parse(JSON.stringify(newProfiles)))
  configStore.setConfigValue('export.lastUsedProfile', profile)
})

function doExport (): void {
  const customCommand = customCommands.value.find(x => x.command === format.value)
  const profile = exportableProfiles.value.find(e => e.name === format.value)
  isExporting.value = true

  if (customCommand !== undefined) {
    // Run the custom command exporter
    ipcRenderer.invoke('application', {
      command: 'custom-export',
      payload: {
        displayName: customCommand.displayName,
        file: props.filePath
      } satisfies CustomExportIPCAPI
    })
      .finally(() => {
        isExporting.value = false
        emit('close')
      })
      .catch(e => console.error(e))
  } else if (profile === undefined) {
    isExporting.value = false
    console.error(`Cannot export: the selected format ${format.value} is neither a runnable profile nor a custom command.`)
  } else {
    // Run the regular exporter
    ipcRenderer.invoke('application', {
      command: 'export',
      payload: {
        // Spread into a plain object: the reactive proxy cannot cross the IPC
        // boundary.
        profile: { ...profile },
        exportTo: exportDirectory.value,
        file: props.filePath
      } satisfies ExportIPCAPI
    })
      .finally(() => {
        isExporting.value = false
        emit('close')
      })
      .catch(e => console.error(e))
  }
}

function getDisplayText (item: ValidPandocProfile): string {
  const name = item.name.substring(0, item.name.lastIndexOf('.'))
  return `${name} (${item.writer})`
}
</script>

<style lang="less">
body {
  .toolbar-export {
    margin: 5px;

    h3, p, strong {
      text-align: center;
      padding-bottom: 5px;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    button {
      width: stretch;
      margin: 5px;
    }

    .form-control {
      padding: 5px;
      select {
          margin-top: 5px;
        }
    }

    .radio-group-container {
      margin: 5px;
    }
  }
}
</style>
@common/util/renderer-path-polyfill
