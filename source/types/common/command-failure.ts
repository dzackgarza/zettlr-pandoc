/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Command failure broadcast
 * CVM-Role:        Types
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     What the command dispatcher sends to the windows when a
 *                  command of the application throws.
 *
 * END HEADER
 */

export const COMMAND_FAILED_CHANNEL = "command-failed";

export interface CommandFailedBroadcast {
  /** The name of the command that was refused or failed. */
  command: string;
  /** The cause, in the words of the error. */
  message: string;
}
