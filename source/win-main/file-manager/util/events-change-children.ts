/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        eventsChangeChildren
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Tells an item of the file manager whether a batch of
 *                  filesystem events changes the list of its children.
 *
 * END HEADER
 */

import type { FSALEventPayload } from 'source/app/service-providers/fsal'
import { relativePath } from '@common/util/renderer-path-polyfill'

/**
 * Whether one of the events adds, changes or removes a direct child of the
 * directory. An event for the directory itself belongs to the item of its
 * parent, and an event for a deeper descendant belongs to the item of a child.
 *
 * @param   {FSALEventPayload[]}  events         One batch of filesystem events
 * @param   {string}              directoryPath  The path of the item
 *
 * @return  {boolean}                            True when the children changed
 */
export function eventsChangeChildren (events: FSALEventPayload[], directoryPath: string): boolean {
  const PATH_SEP = process.platform === 'win32' ? '\\' : '/'
  return events.some(payload => {
    const affectedPath = 'path' in payload ? payload.path : payload.descriptor.path

    if (!affectedPath.startsWith(directoryPath) || affectedPath === directoryPath) {
      return false
    }

    // The relative path of a direct child has no path separator.
    return !relativePath(directoryPath, affectedPath).includes(PATH_SEP)
  })
}
