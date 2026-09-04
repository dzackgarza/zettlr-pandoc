/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Tabbar control
 * CVM-Role:        Types
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The shape TabBar.vue renders one tab from. The badge is
 *                  the annotations tab's open-annotation count (S10); any
 *                  other tab simply never sets it.
 *
 * END HEADER
 */

export interface TabbarControl {
  /** Should match a Clarity icon shape. */
  icon?: string
  /** A unique ID for the tab. */
  id: string
  /** The target ID of whichever tab this represents (for a11y purposes). */
  target: string
  /** A label, may be displayed. */
  label: string
  /** A count shown as a circular badge on the tab. Omitted or 0 renders no badge. */
  badge?: number
}
