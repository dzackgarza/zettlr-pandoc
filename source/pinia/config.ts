/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        useConfigStore
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This model manages the configuration
 *
 * END HEADER
 */

import { type ConfigOptions } from '@providers/config/get-config-template'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import _ from 'underscore'

const ipcRenderer = window.ipc

/**
 * Synchronously retrieves the configuration
 *
 * @return  {ConfigOptions}  The configuration
 */
function retrieveConfig (): ConfigOptions {
  return ipcRenderer.sendSync('config-provider', { command: 'get-config' })
}

export const useConfigStore = defineStore('config', () => {
  const config = ref<ConfigOptions>(retrieveConfig())

  // Throttle the retrieve function to once per 50ms. We want the config to
  // update some values extremely frequently, and with the throttle in place, we
  // ensure that the (sometimes heavy) config updaters don't cause lag.
  const throttledRetrieve = _.throttle(() => {
    config.value = retrieveConfig()
  }, 50)

  // Listen to subsequent changes
  ipcRenderer.on('config-provider', (event, { command }) => {
    if (command === 'update') {
      throttledRetrieve()
    }
  })

  function setConfigValue (property: string, value: unknown): boolean {
    ipcRenderer.sendSync('config-provider', {
      command: 'set-config-single',
      payload: { key: property, val: value }
    })

    // The main-process provider is the authority and validates every write.
    // Its update broadcast reaches this store asynchronously (and is throttled),
    // but callers such as sidebar reveal handlers may need the reactive mirror
    // to reflect a successful synchronous write before the next Vue render.
    // Read the authoritative object back now rather than maintaining a second
    // nested-property setter in the renderer; the later broadcast is harmless.
    config.value = retrieveConfig()

    const segments = property.split('.')
    let current: unknown = config.value
    for (const segment of segments) {
      if (current === null || typeof current !== 'object' || !(segment in current)) {
        return false
      }
      current = (current as Record<string, unknown>)[segment]
    }
    return _.isEqual(current, value)
  }

  return { config, setConfigValue }
})
