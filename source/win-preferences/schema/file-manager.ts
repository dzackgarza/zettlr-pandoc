/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        File Manager Preferences Schema
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Exports the file manager tab schema.
 *
 * END HEADER
 */

import { trans } from '@common/i18n-renderer'
import { type PreferencesFieldset } from './types'
import { PreferencesGroups } from './_preferences-groups'
import type { ConfigOptions } from 'source/app/service-providers/config/get-config-template'

export function getFileManagerFields (config: Pick<ConfigOptions, 'fileNameDisplay'>): PreferencesFieldset[] {
  return [
    {
      title: trans('Display mode'),
      group: PreferencesGroups.FileManager,
      help: undefined, // TODO
      fields: [
        {
          type: 'radio',
          model: 'fileManagerMode',
          inline: true,
          options: {
            thin: trans('Thin'),
            expanded: trans('Expanded'),
            combined: trans('Combined')
          }
        },
        {
          type: 'form-text',
          display: 'info',
          contents: trans('The Thin mode shows your directories and files separately. Select a directory to have its contents displayed in the file list. Switch between file list and directory tree by clicking on directories or the arrow button which appears at the top left corner of the file list.')
        },
        { type: 'separator' },
        {
          type: 'checkbox',
          label: trans('Show file information'),
          model: 'fileMeta'
        },
        {
          type: 'checkbox',
          label: trans('Show folders above files'),
          model: 'sortFoldersFirst'
        }
      ]
    },
    {
      title: trans('Markdown document name display'),
      infoString: trans('Determines how Zettlr will display files in various places such as the file manager.'),
      group: PreferencesGroups.FileManager,
      help: undefined, // TODO
      fields: [
        {
          type: 'radio',
          model: 'fileNameDisplay',
          options: {
            filename: trans('Filename only'),
            title: trans('Title if applicable'),
            heading: trans('First heading if applicable'),
            'title+heading': trans('Title or first heading if applicable')
          }
        },
        {
          // TODO: Checkbox onto the first line of the radio
          type: 'checkbox',
          label: trans('Display Markdown file extensions'),
          info: trans('Only available if name display is set to "Filename only"'),
          model: 'display.markdownFileExtensions',
          disabled: config.fileNameDisplay !== 'filename'
        }
      ]
    },
    {
      title: trans('File types'),
      infoString: trans('The file manager and Ctrl+Shift+P show only files with these extensions. Leave the list empty to show every file type permitted by File Treatment.'),
      group: PreferencesGroups.FileManager,
      help: undefined,
      fields: [
        {
          type: 'token',
          label: trans('Include file extensions'),
          placeholder: trans('Enter an extension, e.g. ".md"'),
          model: 'fileManager.filters.include'
        }
      ]
    },
    {
      title: trans('File filters'),
      infoString: trans('A file or folder that a rule matches is not in the file manager, the launcher, search, links or lint. A rule is one gitignore pattern, for example "*scripts*", "*_files/", "references/" or "AGENTS.md". These rules apply to all workspaces; a workspace adds its own in the file ".zettlrignore" at its root. The menu of the Workspaces header in the file manager has "Edit filters…" for both.'),
      group: PreferencesGroups.FileManager,
      help: undefined,
      fields: [
        {
          type: 'list',
          valueType: 'simpleArray',
          model: 'fileManager.ignoreRules',
          columnLabels: [ trans('Rule') ],
          addable: true,
          editable: true,
          deletable: true,
          emptyMessage: trans('No rules')
        },
        {
          type: 'checkbox',
          label: trans('Show hidden files and folders'),
          model: 'fileManager.showIgnored'
        }
      ]
    },
    {
      title: trans('Time display and sorting'),
      infoString: trans('Determine which timestamp Zettlr shows for files. This also affects sorting by time.'),
      group: PreferencesGroups.FileManager,
      help: undefined, // TODO
      fields: [
        {
          type: 'radio',
          model: 'fileMetaTime',
          options: {
            modtime: trans('Last modification time'),
            creationtime: trans('File creation time')
          }
        }
      ]
    },
    {
      title: trans('Filename sorting'),
      infoString: trans('Determines how Zettlr sorts files and folders when sorting by name.'),
      group: PreferencesGroups.FileManager,
      help: undefined, // TODO
      fields: [
        {
          type: 'radio',
          label: trans('When sorting documents…'),
          model: 'sorting',
          options: {
            natural: trans('Use natural order (2 comes before 10)'),
            ascii: trans('Use ASCII order (2 comes after 10)')
          }
        }
      ]
    },
    {
      title: trans('Workspace sorting'),
      infoString: trans('Zettlr automatically sorts your workspaces by name.'),
      group: PreferencesGroups.FileManager,
      help: undefined, // TODO
      fields: [
        {
          type: 'checkbox',
          label: trans('Sort workspaces manually'),
          info: trans('This will be active as soon as you manually change the sort order. Disable this to reinstate automatic sorting.'),
          model: 'fileManager.sortWorkspacesManually'
        }
      ]
    },
    {
      title: trans('Collapse Workspaces Behavior'),
      group: PreferencesGroups.FileManager,
      infoString: trans('Determine how the context menu item to collapse workspaces in the file manager behaves. You can choose single-step or two-step.'),
      help: undefined, // TODO
      fields: [
        {
          type: 'checkbox',
          label: trans('Require two steps to collapse workspaces'),
          info: trans('When this is active, the first collapse workspace will only collapse subfolders, the second the workspaces.'),
          model: 'fileManager.twoStepCollapseWorkspaces',
        }
      ]
    }
  ]
}
