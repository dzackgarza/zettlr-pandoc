/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Export items for the specs of the exporters
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A spec that calls an exporter gives it an export item. The
 *                  items here come from `exportItems`, the list that the
 *                  application reads, so a spec runs an item as the
 *                  application builds it.
 *
 * END HEADER
 */

import {
  type ExportItem,
  exportItems,
  type SettingsExportItem,
} from "source/app/service-providers/commands/exporter/export-items";

/** One defaults file of an author, as the assets provider lists it. */
export interface DefaultsFile {
  name: string;
  reader: string;
  writer: string;
}

/**
 * The item with the identity, from the list of the application for these
 * defaults files and these items of the settings.
 */
export function exportItem(
  id: string,
  defaults: DefaultsFile[] = [],
  settings: SettingsExportItem[] = [],
): ExportItem {
  const listed = exportItems(
    defaults.map((file) => ({ ...file, isInvalid: false })),
    settings,
  ).find((item) => item.id === id);
  if (listed === undefined) {
    throw new Error(`The list of export items has no item ${id}`);
  }
  if (listed.isInvalid) {
    throw new Error(`The export item ${id} cannot run: ${listed.reason}`);
  }
  return listed;
}
