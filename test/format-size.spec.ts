/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        File size formatter tests
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A size shows in the largest decimal unit that gives a
 *                  number below 1000: 1 Kilobyte is 1000 Byte, 1 Megabyte is
 *                  1000 Kilobyte, 1 Gigabyte is 1000 Megabyte.
 *
 * END HEADER
 */

import { strictEqual } from "node:assert";
import formatSize from "@common/util/format-size";

const sizes: Array<{ bytes: number; long: string; short: string }> = [
  { bytes: 0, long: "0 Byte", short: "0 B" },
  { bytes: 999, long: "999 Byte", short: "999 B" },
  // The first size of a unit
  { bytes: 1000, long: "1 Kilobyte", short: "1 KB" },
  { bytes: 1_000_000, long: "1 Megabyte", short: "1 MB" },
  { bytes: 1_000_000_000, long: "1 Gigabyte", short: "1 GB" },
  // The powers of 1024 and the sizes just below them
  { bytes: 1023, long: "1 Kilobyte", short: "1 KB" },
  { bytes: 1024, long: "1 Kilobyte", short: "1 KB" },
  { bytes: 1_048_575, long: "1 Megabyte", short: "1 MB" },
  { bytes: 1_048_576, long: "1 Megabyte", short: "1 MB" },
  { bytes: 1_073_741_823, long: "1 Gigabyte", short: "1 GB" },
  { bytes: 1_073_741_824, long: "1 Gigabyte", short: "1 GB" },
  // Rounding inside a unit
  { bytes: 1499, long: "1 Kilobyte", short: "1 KB" },
  { bytes: 1500, long: "2 Kilobyte", short: "2 KB" },
  { bytes: 2_600_000, long: "3 Megabyte", short: "3 MB" },
  // The last size that rounds to 999 of a unit, and the first that does not
  { bytes: 999_499, long: "999 Kilobyte", short: "999 KB" },
  { bytes: 999_500, long: "1 Megabyte", short: "1 MB" },
  { bytes: 999_499_999, long: "999 Megabyte", short: "999 MB" },
  { bytes: 999_500_000, long: "1 Gigabyte", short: "1 GB" },
  // The largest unit takes every larger size
  { bytes: 2_500_000_000_000, long: "2500 Gigabyte", short: "2500 GB" },
];

describe("Utility#formatSize()", function () {
  for (const size of sizes) {
    it(`should return "${size.long}" and "${size.short}" for ${size.bytes} bytes`, function () {
      strictEqual(formatSize(size.bytes), size.long);
      strictEqual(formatSize(size.bytes, true), size.short);
    });
  }
});
