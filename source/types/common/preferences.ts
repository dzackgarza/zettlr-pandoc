/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Preferences navigation contract
 * CVM-Role:        Domain
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Shared identity for Preferences groups and launcher
 *                  deep-links. The Preferences renderer owns presentation;
 *                  callers only name the group/field they want revealed.
 *
 * END HEADER
 */

/** Available preference groups in the application-wide Preferences window. */
export enum PreferencesGroups {
  Advanced,
  Appearance,
  Autocorrect,
  Citations,
  Editor,
  FileManager,
  General,
  ImportExport,
  Snippets,
  Spellchecking,
  Zettelkasten,
  Shortcuts
}

/** A destination inside the Preferences window. */
export interface PreferenceNavigationTarget {
  group: PreferencesGroups
  /** The fieldset heading to reveal. */
  fieldsetTitle?: string
  /** The underlying config model to focus when the field exposes one. */
  model?: string
}
