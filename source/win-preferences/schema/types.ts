/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Preferences schema types
 * CVM-Role:        Types
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The fieldset type the preference schemas build. FormBuilder
 *                  owns the form field vocabulary; this module only pins the
 *                  preferences window's group tag onto it. The import is
 *                  type-only, so nothing pulls the Vue component in at
 *                  runtime.
 *
 * END HEADER
 */

import type { Fieldset } from '@common/vue/form/FormBuilder.vue'
import type { PreferencesGroups } from './_preferences-groups'

export type PreferencesFieldset = Fieldset & { group: PreferencesGroups }
