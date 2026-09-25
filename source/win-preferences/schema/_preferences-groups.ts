/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Preferences Group enum
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Exports the preferences groups enum that we can access in
 *                  the preferences.
 *
 * END HEADER
 */

// Kept as the schema-local import path for existing callers; the identity is
// shared because the main window's command launcher can deep-link into this
// separate renderer process.
export { PreferencesGroups } from '@dts/common/preferences'
