/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Image source resolution
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Turns the source of an image in a document into the URI
 *                  that a window loads. Every surface that shows the image
 *                  of a document (the editor, the note preview, the print
 *                  window) resolves the source here.
 *
 * END HEADER
 */

import makeValidUri from "./make-valid-uri";

/**
 * Whether the source of an image holds the image itself (a `data:` URL).
 *
 * @param   {string}   url  The source to check
 *
 * @return  {boolean}       True for a data URL
 */
export function isDataUrl(url: string): boolean {
  return /^data:[a-zA-Z0-9/;=]+(?:;base64){0,1},.+/.test(url);
}

/**
 * Returns the URI that loads an image. A data URL and a remote URL stay as
 * they are. A file path becomes a `safe-file://` URI, and a relative path is
 * resolved against the directory of the document.
 *
 * @param   {string}  imageUrl  The source as the document has it
 * @param   {string}  basePath  The directory of the document
 *
 * @return  {string}            The URI to load
 */
export function imageSourceUri(imageUrl: string, basePath: string): string {
  return isDataUrl(imageUrl) ? imageUrl : makeValidUri(imageUrl, basePath);
}
