/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The title and the listed name of a document
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A document has two names, and each surface shows one of
 *                  them (#203). The title is what a tab, the window and the
 *                  Book module show. The listed name follows the settings of
 *                  the file manager, and the file manager, the launcher, the
 *                  graph, the hover preview and the sort by name show it.
 *                  The file parser gives `yamlTitle`, `firstHeading` and
 *                  `firstSentence` trimmed, and never empty.
 *
 * END HEADER
 */

import type { AnyDescriptor, FileNameDisplay } from "@dts/common/fsal";

/** The file name, without the extension of a Markdown file when the setting hides it. */
export function listedFileName(descriptor: AnyDescriptor, showMarkdownExtensions: boolean): string {
  if (descriptor.type !== "file" || showMarkdownExtensions) {
    return descriptor.name;
  }
  return descriptor.name.slice(0, descriptor.name.length - descriptor.ext.length);
}

/**
 * The name that the file manager lists: the YAML title and then the first
 * heading, each where `fileNameDisplay` asks for it, and then the file name.
 */
export function listedDocumentName(
  descriptor: AnyDescriptor,
  display: FileNameDisplay,
  showMarkdownExtensions: boolean,
): string {
  if (descriptor.type === "file") {
    if (display.includes("title") && descriptor.yamlTitle !== undefined) {
      return descriptor.yamlTitle;
    }
    if (display.includes("heading") && descriptor.firstHeading !== null) {
      return descriptor.firstHeading;
    }
  }
  return listedFileName(descriptor, showMarkdownExtensions);
}

/**
 * The title of a document: the YAML title, the first heading, the first
 * sentence, the file name without its extension. No setting changes it.
 */
export function documentTitle(descriptor: AnyDescriptor): string {
  if (descriptor.type !== "file") {
    return descriptor.name;
  }
  if (descriptor.yamlTitle !== undefined) {
    return descriptor.yamlTitle;
  }
  if (descriptor.firstHeading !== null) {
    return descriptor.firstHeading;
  }
  if (descriptor.firstSentence !== null) {
    return descriptor.firstSentence;
  }
  return listedFileName(descriptor, false);
}
