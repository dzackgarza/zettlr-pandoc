/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Export Preferences Schema
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Exports the export tab schema.
 *
 * END HEADER
 */

import { reportError } from '@common/util/error-reporting'
import { trans } from '@common/i18n-renderer'
import { type PreferencesFieldset } from './types'
import { PreferencesGroups } from './_preferences-groups'
import { ProgrammaticallyOpenableWindows } from '@providers/commands/open-aux-window'
const ipcRenderer = window.ipc

export function getSnippetsFields (): PreferencesFieldset[] {
  return [
    {
      title: trans('Snippets'),
      group: PreferencesGroups.Snippets,
      infoString: trans('Use a VS Code .code-snippets file for snippets. QuickTeX uses a separate Vimscript configuration.'),
      help: undefined, // TODO
      fields: [
        {
          type: 'file',
          label: trans('Snippets file'),
          model: 'editor.snippetsFile',
          placeholder: trans('Path to .code-snippets file'),
          filter: [{ extensions: ['code-snippets'], name: 'VS Code snippets' }]
        },
        {
          type: 'file',
          label: trans('QuickTeX configuration'),
          model: 'editor.quickTexFile',
          placeholder: trans('Path to QuickTeX Vimscript configuration'),
          reset: '',
          filter: [{ extensions: ['vim'], name: 'Vimscript' }]
        },
        {
          type: 'directory',
          label: trans('QuickTeX plugin directory'),
          model: 'editor.quickTexPluginDirectory',
          placeholder: trans('Path to the QuickTeX plugin root'),
          reset: ''
        },
        {
          type: 'button',
          label: trans('Open snippets editor'),
          onClick: () => {
            ipcRenderer.invoke('application', {
              command: 'open-aux-window',
              payload: {
                window: ProgrammaticallyOpenableWindows.AssetsWindow,
                hash: 'tab-snippets-control'
              }
            })
              .catch(err => reportError(err))
          }
        },
        {
          type: 'button',
          label: trans('Open phrase completion dictionary'),
          onClick: () => {
            ipcRenderer.invoke('assets-provider', {
              command: 'open-phrase-completions-directory'
            })
              // shell.openPath resolves with an error message, or '' on success.
              .then(error => {
                if (error !== '') {
                  reportError('Could not open the phrase completion dictionary', error)
                }
              })
              .catch(err => reportError(err))
          }
        }
      ]
    }
  ]
}
