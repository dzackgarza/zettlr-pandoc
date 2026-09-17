/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        File context menu
 * CVM-Role:        Controller
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file displays a context menu for files.
 *
 * END HEADER
 */

import { reportError } from '@common/util/error-reporting'
import { trans } from '@common/i18n-renderer'
import showPopupMenu, { type AnyMenuItem } from '@common/modules/window-register/application-menu-helper'
import type { CodeFileDescriptor, MDFileDescriptor, OtherFileDescriptor, ProjectSettings } from '@dts/common/fsal'
import type { WindowControlsIPCAPI } from 'source/app/service-providers/windows'
import { useConfigStore, useWorkspaceStore } from 'source/pinia'
import { projectMembershipForPath } from '@common/util/explorer-ordering'
import showToast from '@common/util/show-toast'

const ipcRenderer = window.ipc

export function displayFileContext (event: MouseEvent, fileObject: MDFileDescriptor|CodeFileDescriptor|OtherFileDescriptor, el: HTMLElement, callback: (clickedID: string) => void): void {
  const configStore = useConfigStore()
  const workspaceStore = useWorkspaceStore()
  const isMac = process.platform === 'darwin'
  const isWin = process.platform === 'win32'

  const template: AnyMenuItem[] = [
    {
      label: trans('Open in new tab'),
      id: 'new-tab',
      type: 'normal'
    },
    {
      label: trans('Properties'),
      id: 'properties',
      type: 'normal'
    },
    {
      type: 'separator'
    },
    {
      label: trans('Rename file'),
      id: 'menu.rename_file',
      accelerator: 'CmdOrCtrl+R',
      type: 'normal'
    },
    {
      label: trans('Duplicate file'),
      id: 'menu.duplicate_file',
      type: 'normal'
    },
    {
      label: trans('Delete file'),
      id: 'menu.delete_file',
      accelerator: 'CmdOrCtrl+Backspace',
      type: 'normal'
    },
    {
      type: 'separator'
    },
    {
      label: trans('Copy path'),
      id: 'menu.copy_path',
      type: 'normal'
    },
    {
      label: trans('Copy filename'),
      id: 'menu.copy_filename',
      type: 'normal'
    },
    {
      label: trans('Copy ID'),
      id: 'menu.copy_id',
      type: 'normal',
      enabled: fileObject.type === 'file' && fileObject.id !== ''
    },
    {
      type: 'separator'
    },
    {
      label: isMac ? trans('Reveal in Finder') : isWin ? trans('Reveal in Explorer') : trans('Reveal in File Browser'),
      id: 'menu.show_file',
      type: 'normal'
    }
  ]

  const membership = fileObject.type === 'file'
    ? projectMembershipForPath(fileObject.path, workspaceStore.rootDescriptors)
    : undefined
  const canAddToQuartoBook = membership?.manifestKind === 'quarto' && membership.status === 'omitted'
  if (canAddToQuartoBook) {
    template.splice(2, 0, {
      label: trans('Add to Quarto book'),
      id: 'menu.add_to_quarto_book',
      type: 'normal'
    })
  }

  if (configStore.config.app.openFiles.includes(fileObject.path)) {
    template.push(
      { type: 'separator' },
      {
        id: 'menu.close_file',
        type: 'normal',
        label: trans('Close file')
      })
  }

  const point = { x: event.clientX, y: event.clientY }
  showPopupMenu(point, template, (clickedID) => {
    callback(clickedID) // TODO
    switch (clickedID) {
      case 'menu.copy_filename':
        navigator.clipboard.writeText(fileObject.name).catch(err => reportError(err))
        break
      case 'menu.copy_path':
        navigator.clipboard.writeText(fileObject.path).catch(err => reportError(err))
        break
      case 'menu.copy_id':
        if (fileObject.type === 'file') {
          navigator.clipboard.writeText(fileObject.id).catch(err => reportError(err))
        }
        break
      case 'menu.show_file':
        ipcRenderer.send('window-controls', {
          command: 'show-item-in-folder',
          payload: { itemPath: fileObject.path }
        } as WindowControlsIPCAPI)
        break
      case 'menu.add_to_quarto_book':
        if (membership?.manifestKind === 'quarto' && membership.status === 'omitted') {
          ipcRenderer.invoke('application', {
            command: 'quarto-book-edit',
            payload: {
              rootPath: membership.rootPath,
              edit: {
                kind: 'add-chapter',
                chapterPath: fileObject.path.slice(membership.rootPath.length + 1).replace(/\\/g, '/'),
                placement: { kind: 'book-end' }
              }
            }
          }).then((fresh: ProjectSettings) => {
            const root = workspaceStore.descriptorMap.get(membership.rootPath)
            if (root?.type === 'directory') {
              root.settings.project = fresh
            }
            showToast(trans('Added %s to the Quarto book.', fileObject.name))
          }).catch(err => {
            reportError('Could not add file to the Quarto book', err)
            showToast(trans('Could not add the file to the Quarto book: %s', err instanceof Error ? err.message : String(err)), 'error')
          })
        }
        break
    }
  })
}
