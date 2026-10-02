/**
 * BEGIN HEADER
 *
 * Contains:        Utility function
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file contains a utility function to format dates
 *
 * END HEADER
 */

import { DateTime } from "luxon";
import { trans } from "../i18n-renderer";

/**
 * Formats a date based on the given locale.
 *
 * @param   {Date|number}  dateObj           A JavaScript Date object or a timestamp in milliseconds
 * @param   {string}       locale            The locale to use for the formatter
 * @param   {boolean}      [relative=false]  Optional. If true, output a relative timestamp
 *
 * @return  {string}                         The formatted date string
 */
export default function formatDate(
  dateObj: Date | number,
  locale: string,
  relative: boolean = false,
): string {
  const isDate = dateObj instanceof Date;
  const dt = isDate ? DateTime.fromJSDate(dateObj) : DateTime.fromMillis(dateObj);
  if (relative) {
    // A difference of less than one minute shows as "just now".
    if (dt.diff(DateTime.now(), "minutes").toObject().minutes! * -1 < 1) {
      return trans("just now");
    }
    const relativeDate = dt.toRelative({
      style: "short", // Can be short, narrow, or long
      locale,
    });
    if (relativeDate === null) {
      throw new Error(`Cannot format an invalid date: ${dt.invalidExplanation}`);
    }
    return relativeDate;
  } else {
    return dt.toLocaleString({ dateStyle: "long", timeStyle: "short" }, { locale });
  }
}
