/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Minute clock
 * CVM-Role:        Composable
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A `now` that ticks once a minute, for relative times that
 *                  must change without a reload. One interval per component
 *                  that uses it, cleared when the component unmounts.
 *
 * END HEADER
 */

import { onBeforeUnmount, ref, type Ref } from 'vue'
import { DateTime } from 'luxon'

const MINUTE_MS = 60_000

export function useMinuteClock (): Ref<DateTime> {
  const now = ref(DateTime.now())
  const handle = setInterval(() => { now.value = DateTime.now() }, MINUTE_MS)
  onBeforeUnmount(() => { clearInterval(handle) })
  return now
}
