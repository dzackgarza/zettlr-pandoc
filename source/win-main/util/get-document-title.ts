/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Document names of the renderer
 * CVM-Role:        Utility function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     The listed name and the title of a document of the
 *                  workspace store (`common/util/document-title.ts`).
 *
 * END HEADER
 */

import { documentTitle, listedDocumentName } from "@common/util/document-title";
import { pathBasename } from "@common/util/renderer-path-polyfill";
import type { OpenDocument } from "@dts/common/documents";
import { useConfigStore, useWorkspaceStore } from "source/pinia";
import type { AnyDescriptor, FileNameDisplay } from "source/types/common/fsal";

function storedDescriptor(doc: OpenDocument | AnyDescriptor | string): AnyDescriptor | undefined {
  return useWorkspaceStore().descriptorMap.get(typeof doc === "string" ? doc : doc.path);
}

function basenameOf(doc: OpenDocument | AnyDescriptor | string): string {
  return pathBasename(typeof doc === "string" ? doc : doc.path);
}

/**
 * The name that the file manager lists for a document, by the settings of the
 * file manager. `displayOverride` is the display of a folder that sets its own.
 * Only the renderer has the stores.
 */
export default function getDocumentTitle(
  doc: OpenDocument | AnyDescriptor | string,
  displayOverride?: FileNameDisplay,
): string {
  const descriptor = storedDescriptor(doc);
  if (descriptor === undefined) {
    return basenameOf(doc);
  }
  const config = useConfigStore().config;
  return listedDocumentName(
    descriptor,
    displayOverride === undefined ? config.fileNameDisplay : displayOverride,
    config.display.markdownFileExtensions,
  );
}

/** The title of a document, as its tab and the window show it. */
export function getSemanticDocumentTitle(doc: OpenDocument | AnyDescriptor | string): string {
  const descriptor = storedDescriptor(doc);
  return descriptor === undefined ? basenameOf(doc) : documentTitle(descriptor);
}
