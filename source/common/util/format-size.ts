/**
 * BEGIN HEADER
 *
 * Contains:        Utility function
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Formats a size (in bytes) into a human-readable string.
 *
 * END HEADER
 */

// The decimal units of IEC 80000-13, which GLib's g_format_size and the
// ECMA-402 units "kilobyte", "megabyte" and "gigabyte" also use: each unit is
// 1000 of the unit before it.
const UNITS = [
  { long: "Byte", short: "B" },
  { long: "Kilobyte", short: "KB" },
  { long: "Megabyte", short: "MB" },
  { long: "Gigabyte", short: "GB" },
];

/**
 * Takes a size in bytes, and returns a human-readable string in Byte, Kilobyte,
 * Megabyte, or Gigabyte. The unit is the largest one that gives a rounded
 * number below 1000; Gigabyte takes every larger size.
 *
 * @param   {number}  size          The size in bytes.
 * @param   {boolean} [short=false] Whether to use short labels or long ones.
 *
 * @return  {string}                The formatted size.
 */
export default function formatSize(size: number, short: boolean = false): string {
  let unit = 0;
  let value = size;
  while (unit < UNITS.length - 1 && Math.round(value) >= 1000) {
    value /= 1000;
    unit++;
  }
  return `${Math.round(value)} ${short ? UNITS[unit].short : UNITS[unit].long}`;
}
