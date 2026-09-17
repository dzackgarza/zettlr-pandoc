/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        showNotification function
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     A small utility function that can show native OS notifications.
 *
 * END HEADER
 */

import { Notification, nativeImage } from 'electron'
import path from 'path'
import { spawnSync } from 'child_process'

/**
 * The default icon: The Zettlr logo
 */
const defaultIcon = nativeImage.createFromPath(path.join(__dirname, '../img/image-preview.png'))

/**
* Shows a native notification for the operating system. If the operating
* system does not support notifications, the notification will be logged and
* the function returns false.
*
* @param   {string}   message   The message (body) of the notification
* @param   {string}   title     The (optional) title; default is "Zettlr"
* @param   {void}     callback  Optional callback, invoked when user clicks the notification
*
* @return  {boolean}            False if the platform doesn't support notifications.
*/
export function showNativeNotification (
  message: string,
  title?: string,
  callback?: () => void
): boolean {
  if (!Notification.isSupported()) {
    // Electron's Linux notification support depends on the desktop session.
    // `notify-send` is the standard freedesktop/libnotify client and gives us
    // the same dismissible notification surface without owning another UI.
    if (process.platform === 'linux') {
      const result = spawnSync('notify-send', [
        '--app-name=Zettlr-Pandoc',
        '--urgency=normal',
        title ?? 'Zettlr-Pandoc',
        message
      ], { stdio: 'ignore' })
      return result.error === undefined && result.status === 0
    }
    return false
  }

  const notification = new Notification({
    title: title ?? 'Zettlr',
    body: message,
    silent: true,
    icon: defaultIcon,
    hasReply: false, // macOS only
    timeoutType: 'default', // Windows/Linux only
    urgency: 'low', // Linux only, we don't want to distract too much
    closeButtonText: '' // macOS only, empty means to use localized text
  })

  // Now show the notification
  notification.show()

  if (callback !== undefined) {
    notification.on('click', (event) => {
      callback()
    })
  }

  return true
}
