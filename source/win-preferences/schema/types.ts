/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Preferences schema types
 * CVM-Role:        Types
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A renderer-independent copy of the form schema types used
 *                  by the preferences window. Keeping these types in a .ts
 *                  module avoids making the preference schemas import a Vue
 *                  component solely for its type exports.
 *
 * END HEADER
 */

import type { FileFilter } from 'electron'
import type { PreferencesGroups } from './_preferences-groups'

interface BasicInfo {
  model: string
  label?: string
  inline?: boolean
  group?: string
  disabled?: boolean
  placeholder?: string
}

interface Separator { type: 'separator' }
interface FormText { type: 'form-text'; display: 'info' | 'sub-heading' | 'plain'; contents: string }
interface FormButton { type: 'button'; label: string; onClick: () => void }
interface TextField extends BasicInfo { type: 'text'; reset?: string | boolean; info?: string }
interface NumberField extends BasicInfo { type: 'number'; min?: number; max?: number; reset?: number }
interface TimeField extends BasicInfo { type: 'time' }
interface ColorField extends BasicInfo { type: 'color' }
interface FileField extends BasicInfo { type: 'file' | 'directory'; reset?: string | boolean; filter?: FileFilter[] }
interface CheckboxField extends BasicInfo { type: 'checkbox' | 'switch'; info?: string }
interface RadioField extends BasicInfo { type: 'radio'; options: Record<string, string> }
interface SelectField extends BasicInfo { type: 'select'; options: Record<string, string> }
interface ListField extends BasicInfo {
  type: 'list'
  valueType: 'simpleArray' | 'multiArray' | 'record'
  keyNames?: string[]
  columnLabels: string[]
  striped?: boolean
  addable?: boolean
  editable?: boolean | number[]
  deletable?: boolean
  deleteLabel?: string
  searchable?: boolean
  searchLabel?: string
  emptyMessage?: string
}
interface TokenField extends BasicInfo { type: 'token' }
interface SliderField extends BasicInfo { type: 'slider'; min?: number; max?: number }
interface ThemeDescriptor {
  name: string
  description: string
  textColor: string
  backgroundColor: string
  fontFamily: string
}
interface ThemeField extends BasicInfo { type: 'theme'; options: Record<string, ThemeDescriptor> }
interface FilterSelectField extends BasicInfo { type: 'filter-select' }

type FormField = Separator | FormText | FormButton | TextField | NumberField |
  TimeField | ColorField | FileField | CheckboxField | RadioField | SelectField | ListField |
  TokenField | SliderField | ThemeField | FilterSelectField

type TitleFormField = TextField | NumberField | TimeField | ColorField | FileField |
  CheckboxField | RadioField | SelectField | ListField | TokenField | SliderField

interface StyleGroup {
  type: 'style-group'
  style: 'columns'
  label?: string
  fields: FormField[]
}

interface ControlGrid {
  type: 'control-grid'
  header?: string[]
  rows: Array<FormField[]>
}

export interface PreferencesFieldset {
  title: string
  infoString?: string
  help?: string
  titleField?: TitleFormField
  fields: Array<FormField | StyleGroup | ControlGrid>
  group: PreferencesGroups
}
