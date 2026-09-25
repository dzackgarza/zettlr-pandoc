/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Preferences schema catalogue
 * CVM-Role:        Model
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The authoritative assembly of Preferences groups and
 *                  fieldsets, shared by the Preferences window and the Ctrl-P
 *                  launcher index. This prevents the launcher from carrying a
 *                  hand-maintained shadow list of settings.
 *
 * END HEADER
 */

import { trans } from '@common/i18n-renderer'
import type { ConfigOptions } from 'source/app/service-providers/config/get-config-template'
import type { FormField, Fieldset } from '@common/vue/form/FormBuilder.vue'
import { PreferencesGroups, type PreferenceNavigationTarget } from '@dts/common/preferences'
import { getAdvancedFields } from './advanced'
import { getAppearanceFields } from './appearance'
import { getAutocorrectFields } from './autocorrect'
import { getCitationFields } from './citations'
import { getEditorFields } from './editor'
import { getFileManagerFields } from './file-manager'
import { getGeneralFields } from './general'
import { getImportExportFields } from './import-export'
import { getShortcutFields } from './shortcuts'
import { getSnippetsFields } from './snippets'
import { getSpellcheckingFields } from './spellchecking'
import type { PreferencesFieldset } from './types'
import { getZettelkastenFields } from './zettelkasten'

export interface PreferenceGroupDescriptor {
  id: PreferencesGroups
  displayText: string
  icon: string
}

/** One searchable destination exposed to the command launcher. */
export interface PreferenceIndexEntry extends PreferenceNavigationTarget {
  label: string
  groupLabel: string
  /** Terms not necessarily suitable as the visible row label. */
  aliases: readonly string[]
}

/** Preferences sidebar groups in their actual display order. */
export function getPreferenceGroups (): PreferenceGroupDescriptor[] {
  return [
    { displayText: trans('General'), icon: 'cog', id: PreferencesGroups.General },
    { displayText: trans('Appearance'), icon: 'paint-roller', id: PreferencesGroups.Appearance },
    { displayText: trans('File Manager'), icon: 'folder-open', id: PreferencesGroups.FileManager },
    { displayText: trans('Editor'), icon: 'align-left-text', id: PreferencesGroups.Editor },
    { displayText: trans('Spellchecking'), icon: 'text', id: PreferencesGroups.Spellchecking },
    { displayText: trans('Autocorrect'), icon: 'wand', id: PreferencesGroups.Autocorrect },
    { displayText: trans('Citations'), icon: 'chat-bubble', id: PreferencesGroups.Citations },
    { displayText: trans('Shortcuts'), icon: 'keyboard', id: PreferencesGroups.Shortcuts },
    { displayText: trans('Zettelkasten'), icon: 'details', id: PreferencesGroups.Zettelkasten },
    { displayText: trans('Snippets'), icon: 'add-text', id: PreferencesGroups.Snippets },
    { displayText: trans('Import and Export'), icon: 'two-way-arrows', id: PreferencesGroups.ImportExport },
    { displayText: trans('Advanced'), icon: 'cpu', id: PreferencesGroups.Advanced }
  ]
}

/** Every fieldset rendered by Preferences, in its existing schema order. */
export function getPreferenceFieldsets (
  config: ConfigOptions,
  appLangOptions: Record<string, string> = {}
): PreferencesFieldset[] {
  return [
    ...getAdvancedFields(config),
    ...getAppearanceFields(config),
    ...getAutocorrectFields(),
    ...getCitationFields(),
    ...getEditorFields(config),
    ...getFileManagerFields(config),
    ...getGeneralFields(appLangOptions),
    ...getImportExportFields(),
    ...getShortcutFields(config),
    ...getSnippetsFields(),
    ...getSpellcheckingFields(config),
    ...getZettelkastenFields(config)
  ]
}

function optionAliases (field: FormField): string[] {
  if (field.type === 'radio' || field.type === 'select') {
    return [ ...Object.keys(field.options), ...Object.values(field.options) ]
  }
  if (field.type === 'theme') {
    return [
      ...Object.keys(field.options),
      ...Object.values(field.options).flatMap(option => [ option.name, option.description ])
    ]
  }
  return []
}

interface IndexableField {
  field: FormField
  /** Visible meaning supplied either by the control or its structural context. */
  label?: string
  contextAliases: readonly string[]
}

function indexableFields (fieldset: Fieldset): IndexableField[] {
  const fields: IndexableField[] = []
  if (fieldset.titleField !== undefined) {
    fields.push({
      field: fieldset.titleField,
      label: fieldset.titleField.label,
      contextAliases: []
    })
  }
  for (const field of fieldset.fields) {
    if (field.type === 'style-group') {
      fields.push(...field.fields.map(child => ({
        field: child,
        label: 'label' in child ? child.label : undefined,
        contextAliases: field.label === undefined ? [] : [ field.label ]
      })))
    } else if (field.type === 'control-grid') {
      for (const row of field.rows) {
        const rowLabel = row.find(child => child.type === 'form-text')
        const rowContext = rowLabel?.type === 'form-text' ? rowLabel.contents : undefined
        row.forEach((child, column) => {
          const columnLabel = field.header?.[column]
          const ownLabel = 'label' in child ? child.label : undefined
          const inferredLabel = ownLabel ?? [ rowContext, columnLabel ]
            .filter((value): value is string => value !== undefined && value !== '')
            .join(' — ')
          fields.push({
            field: child,
            label: inferredLabel === '' ? undefined : inferredLabel,
            contextAliases: [ rowContext, columnLabel ]
              .filter((value): value is string => value !== undefined && value !== '')
          })
        })
      }
    } else {
      fields.push({
        field,
        label: 'label' in field ? field.label : undefined,
        contextAliases: field.type === 'form-text' ? [ field.contents ] : []
      })
    }
  }
  return fields
}

/** The search texts a schema actually authors: absent and empty strings name nothing. */
function authoredTexts (texts: ReadonlyArray<string | undefined>): string[] {
  return texts.filter((text): text is string => text !== undefined && text !== '')
}

/**
 * Builds the launcher's Preferences index directly from the form schema.
 * Fieldset entries make every card reachable; labeled controls add more
 * precise destinations. Explanatory text and option labels enrich search but
 * do not become duplicate rows.
 */
export function buildPreferenceIndex (config: ConfigOptions): PreferenceIndexEntry[] {
  const groupLabels = new Map(getPreferenceGroups().map(group => [ group.id, group.displayText ]))
  const rows: PreferenceIndexEntry[] = []

  for (const fieldset of getPreferenceFieldsets(config)) {
    const groupLabel = groupLabels.get(fieldset.group)
    if (groupLabel === undefined) {
      throw new Error(`Preferences fieldset ${fieldset.title} belongs to an unknown group ${fieldset.group}`)
    }
    const fields = indexableFields(fieldset)
    const firstModel = fields.find(({ field }) => 'model' in field)?.field
    const firstModelName = firstModel !== undefined && 'model' in firstModel ? firstModel.model : undefined
    const fieldsetAliases = authoredTexts([
      fieldset.infoString,
      fieldset.help,
      ...fields.flatMap(({ field, label, contextAliases }) => [
        label,
        'model' in field ? field.model : undefined,
        'info' in field ? field.info : undefined,
        ...contextAliases,
        ...optionAliases(field)
      ])
    ])

    rows.push({
      group: fieldset.group,
      groupLabel,
      fieldsetTitle: fieldset.title,
      model: firstModelName,
      label: fieldset.title,
      aliases: fieldsetAliases
    })

    // A destination is its model (or none) plus its label; JSON keeps "no
    // model" distinct from every model name.
    const seenTargets = new Set([ JSON.stringify([ firstModelName, fieldset.title ]) ])
    for (const { field, label, contextAliases } of fields) {
      if (label === undefined || label === '') {
        continue
      }
      // Plain explanatory text enriches search for the fieldset but is not an
      // actionable Preferences destination of its own.
      if (field.type === 'form-text' || field.type === 'separator') {
        continue
      }
      const model = 'model' in field ? field.model : undefined
      const identity = JSON.stringify([ model, label ])
      if (seenTargets.has(identity)) {
        continue
      }
      seenTargets.add(identity)
      rows.push({
        group: fieldset.group,
        groupLabel,
        fieldsetTitle: fieldset.title,
        model,
        label,
        aliases: authoredTexts([
          'model' in field ? field.model : undefined,
          'info' in field ? field.info : undefined,
          ...contextAliases,
          ...optionAliases(field)
        ])
      })
    }
  }

  return rows
}
