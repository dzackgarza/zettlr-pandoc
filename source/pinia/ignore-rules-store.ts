/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Ignore rules store
 * CVM-Role:        Model
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The ignore rules that the FSAL lists with, for the window.
 *                  The FSAL owns the rules and does the filtering; a window
 *                  reads them to mark what a rule matches and to show the
 *                  rules for an edit.
 *
 * END HEADER
 */

import { reportError } from '@common/util/error-reporting'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'
import { createIgnoreFilter, judgingRoot, type IgnoreFilter, type IgnoreRuleSources } from 'source/common/util/ignore-rules'
import { useConfigStore } from './config'

const ipcRenderer = window.ipc

/**
 * The folder itself when the app lists it, else the nearest folder above it
 * that the app lists.
 */
function nearestListedDirectory (filter: IgnoreFilter, roots: Iterable<string>, dirPath: string): string {
  const root = judgingRoot(roots, dirPath)
  if (root === undefined) {
    return dirPath
  }

  let listed = root
  for (const segment of dirPath.slice(root.length + 1).split('/')) {
    const next = `${listed}/${segment}`
    if (filter.hides(next, true)) {
      return listed
    }
    listed = next
  }
  return dirPath
}

export const useIgnoreRulesStore = defineStore('ignore-rules', () => {
  const configStore = useConfigStore()
  const sources = shallowRef<IgnoreRuleSources>({ globalRules: [], workspaceRules: new Map(), showIgnored: false })
  const filter = computed(() => createIgnoreFilter(sources.value))
  /** True while the dialog that edits the rules is open. */
  const editing = ref(false)

  ipcRenderer.invoke('fsal', { command: 'get-ignore-rules' })
    .then(current => { sources.value = current })
    .catch(err => reportError('Could not fetch the ignore rules', err))

  ipcRenderer.on('fsal-ignore-rules', (_, next: IgnoreRuleSources) => { sources.value = next })

  // A rule can hide the selected folder. The selection then moves to the
  // nearest folder that is still listed.
  watch(filter, () => {
    const selected = configStore.config.openDirectory
    if (selected === null) {
      return
    }
    const listed = nearestListedDirectory(filter.value, sources.value.workspaceRules.keys(), selected)
    if (listed !== selected) {
      configStore.setConfigValue('openDirectory', listed)
    }
  })

  return { sources, filter, editing }
})
