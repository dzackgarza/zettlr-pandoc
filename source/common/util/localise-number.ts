/**
 * BEGIN HEADER
 *
 * Contains:        Utility function
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file contains a utility function to localise numbers.
 *
 * END HEADER
 */

/**
 * Formats numbers with locale delimiters using standard Intl.NumberFormat.
 *
 * @param  {number} number The number to be localised.
 *
 * @return {string}        The number with delimiters.
 */
export default function (number: number): string {
  if (typeof number !== 'number' || !Number.isFinite(number)) {
    return String(number)
  }
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 20 }).format(number)
}
