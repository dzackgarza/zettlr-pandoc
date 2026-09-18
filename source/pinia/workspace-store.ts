/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        useWorkspaceStore
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This store manages all loaded files and folders including
 *                  their descriptors.
 *
 * END HEADER
 */

import { reportError } from '@common/util/error-reporting'
import { defineStore } from 'pinia'
import { type Ref, ref, watch, computed, shallowRef, triggerRef } from 'vue'
import { useConfigStore } from './config'
import type { AnyDescriptor } from 'source/types/common/fsal'
import type { FSALEventPayload } from 'source/app/service-providers/fsal'
import { isInsideRoot } from '@common/util/renderer-path-polyfill'

const ipcRenderer = window.ipc

/**
 * Reads in an entire (workspace) path into a 1d array of absolute file paths.
 *
 * @param   {string}             absPath  The path to read
 *
 * @return  {Promise<string>[]}           A list of everything recursively within the path.
 */
async function readPathRecursively (absPath: string): Promise<string[]> {
  return await ipcRenderer.invoke('fsal', { command: 'read-path-recursively', payload: absPath })
}

/**
 * Returns a single or multiple descriptors from main for the provided path.
 *
 * @param   {string}                  absPath  The absolute path
 *
 * @return  {Promise<AnyDescriptor>}           The descriptor for path.
 */
async function getDescriptorFor (absPath: string): Promise<AnyDescriptor>
async function getDescriptorFor (absPath: string[]): Promise<AnyDescriptor[]>
async function getDescriptorFor (absPath: string|string[]): Promise<AnyDescriptor|AnyDescriptor[]> {
  return await ipcRenderer.invoke('fsal', {
    command: 'get-descriptor',
    // De-proxy as necessary
    payload: Array.isArray(absPath) ? absPath.map(p => p) : absPath
  })
}

// In order to avoid frequent updates of the workspaceMap on initial load, we
// retrieve the bulk immediately on load, and then only patch where necessary.
async function retrieveInitialUpdate (rootPaths: string[], workspaceMap: Ref<Map<string, string[]>>, descriptorMap: Ref<Map<string, AnyDescriptor>>) {
  let start = Date.now()
  const entries: Array<[string, string[]]> = []
  const flatMap: string[] = []
  for (const rootPath of rootPaths) {
    const response = await readPathRecursively(rootPath)
    entries.push([ rootPath, response ])
    flatMap.push(...response)
  }
  console.log(`Fetched all paths in ${Date.now() - start}ms`)
  start = Date.now()

  // Now do one huge roundtrip to main to fetch every descriptor at once.
  const descriptors = await getDescriptorFor(flatMap)
  console.log(`Fetched all descriptors in ${Date.now() - start}ms`)

  // Now we can set the stuff immediately
  workspaceMap.value = new Map(entries)
  descriptorMap.value = new Map(descriptors.map(descriptor => [ descriptor.path, descriptor ]))
}

export const useWorkspaceStore = defineStore('workspace', () => {
  // Dependent stores and watched variables
  const configStore = useConfigStore()

  // SECTION 1: WORKSPACES AND FILE DESCRIPTORS
  const openFiles = configStore.config.app.openFiles
  const openWorkspaces = configStore.config.app.openWorkspaces
  const openPaths = ref(openFiles.concat(openWorkspaces))

  const workspaceMap = ref<Map<string, string[]>>(new Map())
  const pathList = computed(() => ([...workspaceMap.value.values()].flat()))
  // The collection is reactive, but descriptor values are immutable snapshots
  // replaced wholesale on FSAL events. Avoid recursively proxying every nested
  // descriptor in large workspaces.
  const descriptorMap = shallowRef(new Map<string, AnyDescriptor>())
  const rootDescriptors = shallowRef<AnyDescriptor[]>([])

  const isLoading = ref(true)

  function refreshRootDescriptors (): void {
    rootDescriptors.value = openPaths.value
      .filter(rootPath => descriptorMap.value.has(rootPath))
      .map(rootPath => descriptorMap.value.get(rootPath))
      .filter(root => root !== undefined)
  }

  function setDescriptors (descriptors: readonly AnyDescriptor[]): void {
    if (descriptors.length === 0) {
      return
    }
    let rootsChanged = false
    for (const descriptor of descriptors) {
      descriptorMap.value.set(descriptor.path, descriptor)
      rootsChanged ||= openPaths.value.includes(descriptor.path)
    }
    triggerRef(descriptorMap)
    if (rootsChanged) {
      refreshRootDescriptors()
    }
  }

  function setDescriptor (descriptor: AnyDescriptor): void {
    setDescriptors([ descriptor ])
  }

  function deleteDescriptors (paths: readonly string[]): void {
    if (paths.length === 0) {
      return
    }
    let rootsChanged = false
    let changed = false
    for (const path of paths) {
      changed ||= descriptorMap.value.delete(path)
      rootsChanged ||= openPaths.value.includes(path)
    }
    if (changed) {
      triggerRef(descriptorMap)
    }
    if (rootsChanged) {
      refreshRootDescriptors()
    }
  }

  function deleteDescriptor (path: string): void {
    deleteDescriptors([ path ])
  }

  retrieveInitialUpdate(openPaths.value, workspaceMap, descriptorMap)
    .then(() => { refreshRootDescriptors() })
    .catch(err => reportError('[Workspace Store] Could not retrieve initial set of loaded paths', err))
    .finally(() => {
      isLoading.value = false
      // Now we can set up the watchers. (We need to do this afterwards to not cause a hiccup)
      // Finally, listen to FSAL events and keep the descriptor map updated.
      ipcRenderer.on('fsal-event', (_, payload: FSALEventPayload) => {
        const eventPath = 'path' in payload ? payload.path : payload.descriptor.path
        console.log(`[WorkspaceStore] Received event ${payload.event}:${eventPath}`)
        if (payload.event === 'unlink' || payload.event === 'unlinkDir') {
          for (const [root, paths] of workspaceMap.value) {
            if (payload.path !== root && !isInsideRoot(payload.path, root)) {
              continue
            }
            workspaceMap.value.set(root, paths.filter(path => path !== payload.path))
          }

          deleteDescriptor(payload.path)
        } else if (payload.event === 'change' || payload.event === 'add' || payload.event === 'addDir') {
          for (const [root, paths] of workspaceMap.value) {
            const path = payload.descriptor.path
            if (payload.event === 'change' || (path !== root && !isInsideRoot(path, root)) || paths.includes(path)) {
              continue
            }
            workspaceMap.value.set(root, [...paths, path])
          }

          setDescriptor(payload.descriptor)
        }
      })
    })

  // Update the loaded workspaces as soon as the openPaths property changes.
  configStore.$subscribe((_mutation, state) => {
    const openFiles = state.config.app.openFiles
    const openWorkspaces = state.config.app.openWorkspaces
    openPaths.value = openFiles.concat(openWorkspaces)
  })

  watch(openPaths, async (value) => {
    // Whenever openPaths changes, also update the rootDescriptors to reflect a
    // potentially changed sorting.
    refreshRootDescriptors()

    // Retrieve all new paths to load.
    const pathsToLoad: string[] = []
    for (const newPath of value) {
      if (!workspaceMap.value.has(newPath)) {
        pathsToLoad.push(newPath)
      }
    }

    // Fetch the new paths.
    for (const rootPath of pathsToLoad) {
      try {
        const response = await readPathRecursively(rootPath)
        workspaceMap.value.set(rootPath, response)
      } catch (err) {
        reportError(`[Workspace Store] Could not retrieve path: "${rootPath}"`, err)
      }
    }

    // Unload any path no longer part of the open paths.
    for (const existingPath of workspaceMap.value.keys()) {
      if (!value.includes(existingPath)) {
        workspaceMap.value.delete(existingPath)
      }
    }
  })

  // Keep the descriptor map up to date
  watch(workspaceMap, value => {
    if (isLoading.value) {
      return // The loader will update the descriptorMap once with a huge chunk of updates.
    }

    const descriptorsToFetch: string[] = []
    const flatMap: Set<string> = new Set()

    for (const contents of value.values()) {
      for (const absPath of contents) {
        flatMap.add(absPath)
        if (!descriptorMap.value.has(absPath)) {
          descriptorsToFetch.push(absPath)
        }
      }
    }

    // First, start loading new descriptors
    getDescriptorFor(descriptorsToFetch)
      .then(descriptors => { setDescriptors(descriptors) })
      .catch(err => reportError('Could not fetch new descriptors from main!', err))

    // Second, drop descriptors no longer loaded in one reactive publication.
    const descriptorsToDelete: string[] = []
    for (const existingDescriptor of descriptorMap.value.keys()) {
      if (!flatMap.has(existingDescriptor)) {
        descriptorsToDelete.push(existingDescriptor)
      }
    }
    deleteDescriptors(descriptorsToDelete)
  }, { deep: true })


  return { workspaceMap, pathList, descriptorMap, rootDescriptors }
})
