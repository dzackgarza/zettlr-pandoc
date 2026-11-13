/**
 * BEGIN HEADER
 *
 * Contains:        Utility function
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Sorts an array of strings with PDF at the top.
 *
 * END HEADER
 */

import { hasPDFExt } from "./file-extention-checks";

/**
 * Sorting function that sorts PDF files to be at the top
 *
 * @param  {string} a The first comparator
 * @param  {string} b The second comparator
 *
 * @return {number}   A number for consumption by Array.sort()
 */
export default function sortByPDF(a: string, b: string): number {
  let isAPDF = hasPDFExt(a);
  let isBPDF = hasPDFExt(b);

  if (isAPDF && isBPDF) {
    return 0;
  } else if (isAPDF) {
    return -1;
  } else if (isBPDF) {
    return 1;
  }

  return 0;
}
