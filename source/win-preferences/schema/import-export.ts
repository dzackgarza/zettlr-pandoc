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

export function getImportExportFields (): PreferencesFieldset[] {
  return [
    {
      title: trans('Import and export profiles'),
      group: PreferencesGroups.ImportExport,
      help: undefined, // TODO
      fields: [
        {
          type: 'button',
          label: trans('Open import profiles editor'),
          onClick: () => {
            ipcRenderer.invoke('application', {
              command: 'open-aux-window',
              payload: {
                window: ProgrammaticallyOpenableWindows.AssetsWindow,
                hash: 'tab-import-control'
              }
            })
              .catch(err => reportError(err))
          }
        },
        {
          type: 'button',
          label: trans('Open export profiles editor'),
          onClick: () => {
            ipcRenderer.invoke('application', {
              command: 'open-aux-window',
              payload: {
                window: ProgrammaticallyOpenableWindows.AssetsWindow,
                hash: 'tab-export-control'
              }
            })
              .catch(err => reportError(err))
          }
        }
      ] // TODO: Add two buttons "Open import profiles editor" and "Open export profiles editor"
    },
    {
      title: trans('Export settings'),
      group: PreferencesGroups.ImportExport,
      help: undefined, // TODO
      fields: [
        {
          type: 'checkbox', // TODO: Must be radio; second option "Use system-wide Pandoc for exports"
          label: trans('Use Zettlr\'s internal Pandoc for exports'),
          model: 'export.useBundledPandoc'
        },
        {
          type: 'checkbox',
          label: trans('Automatically open successfully exported files'),
          model: 'export.autoOpenExportedFiles'
        },
        {
          type: 'checkbox',
          label: trans('Preserve highlighted text on export'),
          info: trans('Enable Pandoc\'s mark extension when exporting Markdown.'),
          model: 'export.enforceMarkSupport'
        },
        { type: 'separator' },
        {
          type: 'checkbox',
          label: trans('Remove tags from files when exporting'),
          model: 'export.stripTags'
        },
        { type: 'separator' },
        {
          type: 'radio',
          label: trans('Internal links'),
          model: 'export.stripLinks',
          options: {
            full: trans('Remove internal links completely'),
            unlink: trans('Unlink internal links'),
            no: trans('Don\'t touch internal links')
          }
        },
        { type: 'separator' },
        {
          type: 'radio',
          label: trans('Destination folder for exported files'),
          model: 'export.dir',
          options: {
            // TODO: Add info-strings
            temp: trans('Temporary folder'),
            cwd: trans('Same as file location'),
            ask: trans('Ask for folder when exporting')
          }
        },
        {
          type: 'form-text',
          display: 'info',
          contents: trans('Warning! Files in the temporary folder are regularly deleted. Choosing the same location as the file overwrites files with identical filenames if they already exist.')
        }
      ]
    },
    {
      title: trans('Custom export commands'),
      infoString: trans('Specify custom commands to run the exporter with. Each command receives as its first argument the file or project folder to be exported.'),
      group: PreferencesGroups.ImportExport,
      help: undefined, // TODO
      fields: [
        {
          type: 'list',
          valueType: 'record',
          keyNames: [ 'displayName', 'command' ],
          columnLabels: [ trans('Display name'), trans('Command') ],
          model: 'export.customCommands',
          deletable: true,
          searchable: true,
          addable: true,
          editable: true
        }
      ]
    },
    {
      title: trans('Export templates'),
      infoString: trans('Choose the default template used when an export profile does not specify one. Select a file or enter a template name from ~/.pandoc/templates.'),
      group: PreferencesGroups.ImportExport,
      help: undefined,
      fields: [
        {
          type: 'file',
          label: trans('HTML template (HTML, reveal.js)'),
          model: 'export.htmlTemplate',
          placeholder: trans('Pandoc default'),
          reset: '',
          filter: [{ extensions: [ 'html', 'htm', 'template' ], name: 'HTML template' }]
        },
        {
          type: 'file',
          label: trans('LaTeX template (LaTeX, PDF, Beamer)'),
          model: 'export.latexTemplate',
          placeholder: trans('Pandoc default'),
          reset: '',
          filter: [{ extensions: [ 'tex', 'latex', 'template' ], name: 'LaTeX template' }]
        }
      ]
    },
    {
      title: trans('Export filters'),
      infoString: trans('Choose Lua filters to run on every export. They run in the order shown, before filters defined by the export profile. Available filters come from ~/.pandoc/filters and Zettlr\'s lua-filter folder.'),
      group: PreferencesGroups.ImportExport,
      help: undefined,
      fields: [
        {
          type: 'filter-select',
          label: trans('Enabled export filters'),
          model: 'export.filters'
        }
      ]
    },
    {
      title: trans('Export scripts'),
      infoString: trans('Add an export format that runs a command after the selected profile. The command receives the intermediate file first and the output path second.'),
      group: PreferencesGroups.ImportExport,
      help: undefined,
      fields: [
        {
          type: 'list',
          valueType: 'record',
          keyNames: [ 'name', 'profile', 'command', 'extension' ],
          columnLabels: [ trans('Name'), trans('Profile'), trans('Command'), trans('Extension') ],
          model: 'export.scripts',
          deletable: true,
          searchable: true,
          addable: true,
          editable: true
        }
      ]
    }
  ]
}
