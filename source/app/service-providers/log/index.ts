/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        LogProvider
 * CVM-Role:        Service Provider
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Handles application logging
 *
 * END HEADER
 */

import path from 'path'
import { promises as fs } from 'fs'
import { app, ipcMain } from 'electron'
import chalk from 'chalk'
import ProviderContract from '../provider-contract'

/**
 * How many logfiles should the app keep at most?
 *
 * @var {number}
 */
const LOG_FILES_TO_KEEP = 30

/**
 * Available LogLevels BUG: Somehow I have to declare this twice. That happens
 * if you devise a system for typings where you can put types "somewhere."
 */
enum LogLevel {
  verbose = 1,
  info = 2,
  warning = 3,
  error = 4
}

/**
 * Whatever a caller attaches to a log entry -- commonly a caught `unknown`, an
 * Error, or a plain object. `unknown` rather than `any`, so both the log viewer
 * and _toString below are forced to narrow by `instanceof`, `Array.isArray` and
 * `typeof` before touching it, instead of silently trusting a shape.
 */
export type LogDetails = unknown

/**
 * A single log message
 */
export interface LogMessage {
  time: string
  level: LogLevel
  message: string
  details?: LogDetails
}

const debugConsole = {
  error: function (message: string) { console.error(chalk.bold.red(message)) },
  warn: function (message: string) { console.warn(chalk.yellow(message)) },
  info: function (message: string) { console.log(chalk.blueBright(message)) },
  verbose: function (message: string) { console.log(chalk.grey(message)) }
}

export default class LogProvider extends ProviderContract {
  private readonly _logPath: string
  private readonly _log: LogMessage[]
  private _entryPointer: number
  private _activeWrite: Promise<void>|null

  constructor () {
    super()
    this._logPath = path.join(app.getPath('userData'), 'logs')
    this._log = []
    this._entryPointer = 0 // Set the log entry file pointer to zero
    this._activeWrite = null // The write in flight, so callers can wait for it

    // Ensure message handling
    ipcMain.handle('log-provider', (event, payload: { command: string, nextIndex?: number|string }) => {
      const { command } = payload

      if (command === 'retrieve-log-chunk') {
        const nextIndex = parseInt(String(payload.nextIndex), 10)
        if (nextIndex >= this._log.length || nextIndex < 0) {
          return []
        }

        return this._log.slice(nextIndex)
      }
    })
  }

  public verbose (msg: string, details: LogDetails = null): void {
    this.log(LogLevel.verbose, msg, details)
  }

  public info (msg: string, details: LogDetails = null): void {
    this.log(LogLevel.info, msg, details)
  }

  public warning (msg: string, details: LogDetails = null): void {
    this.log(LogLevel.warning, msg, details)
  }

  public error (msg: string, details: LogDetails = null): void {
    this.log(LogLevel.error, msg, details)
  }

  async boot (): Promise<void> {
    this.verbose('Log provider booting up ...')
    await this._cleanLogs() // Remove all older logs
  }

  /**
   * Shuts down the provider
   * @return {Boolean} Whether or not the shutdown was successful
   */
  async shutdown (): Promise<void> {
    this.verbose('Log provider shutting down ...')
    await this._append() // One final append to flush the log
  }

  /**
   * Logs one entry to the internal log.
   * @param {number} logLevel The log level (defined atop of this file)
   * @param {string} message A short, human-readable error message
   * @param {LogDetails} details Optional details (completely customisable)
   */
  log (logLevel: LogLevel, message: string, details: LogDetails): void {
    if (details == null) {
      details = {} // No details -> empty object
    }

    // Simply append to log
    const msg = {
      level: logLevel,
      message,
      details,
      time: this._getTimestamp()
    }

    this._log.push(msg)

    if (!app.isPackaged) {
      // Also output to stdio
      const output = `[${msg.time}] ${msg.message}`
      switch (msg.level) {
        case LogLevel.error:
          debugConsole.error(output)
          // In case of an error, spit out anything that comes in
          console.error(msg.details)
          break
        case LogLevel.info:
          debugConsole.info(output)
          break
        case LogLevel.verbose:
          debugConsole.verbose(output)
          break
        case LogLevel.warning:
          debugConsole.warn(output)
          break
      }
    }

    this._append()
      .catch(() => {
        // _append() has already reported the failure out of band. Reporting it
        // again from here would route the report through the very writer that
        // just failed, which is where such reports go to die.
      })
  }

  /**
   * Reports a failure of the log's own file write.
   *
   * This deliberately does not go through log(): that queues another append,
   * and a write that keeps failing would then keep generating reports of its
   * own failure that it also cannot write. The report goes to stderr -- a
   * channel that is not the one that just failed, and that is open in a
   * packaged build too, unlike the debug output in log() -- and into the
   * in-memory log, which the log viewer reads and which the next successful
   * append carries to disk.
   *
   * @param {unknown} err The reason the write rejected
   */
  private _reportWriteFailure (err: unknown): void {
    const reason = (err instanceof Error) ? err.message : 'unknown error'
    const message = `[Log Provider] Could not write to the logfile: ${reason}. ` +
      'The affected entries are kept in memory and retried with the next log entry.'
    console.error(chalk.bold.red(message))
    this._log.push({
      level: LogLevel.error,
      message,
      details: err,
      time: this._getTimestamp()
    })
  }

  /**
   * Removes old logfiles so that at max there are 30 files present.
   */
  async _cleanLogs (): Promise<void> {
    // Get all logs
    let logfiles = await fs.readdir(this._logPath, 'utf8')

    // Make sure we only have log files, sorted ascending
    logfiles = logfiles.filter((elem) => /\.log$/.test(elem))
    logfiles = logfiles.sort()

    // Now use this loop to remove files until there are max 30
    // files left. Prevents disk space running full.
    while (logfiles.length > LOG_FILES_TO_KEEP) {
      // Remove the first file from the array
      const nextLogFile = logfiles.shift()
      if (nextLogFile !== undefined) {
        let toRemove = path.join(this._logPath, nextLogFile)
        await fs.unlink(toRemove)
      }
    }
  }

  /**
   * Appends all not-yet-written log messages to today's log file
   */
  async _append (): Promise<void> {
    // A caller arriving while a write is in flight waits for that write instead
    // of returning as though the log had been flushed. shutdown()'s final append
    // is the last chance the pending entries have to reach disk, and the entry
    // shutdown() logs on its own first line has already started a write by the
    // time it gets here -- so returning early would make that flush a no-op that
    // hands back a resolved promise for work nobody did.
    while (this._activeWrite !== null) {
      await this._activeWrite
    }

    // The pointer counts entries already written, so it is the index of the
    // first unwritten one -- equal to the length exactly when nothing is pending.
    if (this._entryPointer >= this._log.length) {
      return // Nothing to write
    }

    this._activeWrite = this._writePendingEntries()

    try {
      await this._activeWrite
    } finally {
      // Cleared on every path, a rejected write included: an in-flight marker
      // left standing would park every later append on a settled promise for the
      // rest of the process, and the log would be dead without saying so.
      this._activeWrite = null
    }
  }

  /**
   * Writes everything the logfile is behind on, keeping the read pointer honest
   * about what actually reached disk.
   */
  private async _writePendingEntries (): Promise<void> {
    try {
      // Keep going until the whole log is on disk. Entries arriving while the
      // write below is awaited wait on this very call, so if it stopped after one
      // batch they would sit unwritten until some later, unrelated log entry
      // happened to drag them along.
      while (this._entryPointer < this._log.length) {
        const nextPointer = this._log.length
        const logsToWrite = this._log
          .slice(this._entryPointer, nextPointer)
          .filter((entry) => entry.level > LogLevel.verbose) // Verbose stays out of the file

        if (logsToWrite.length > 0) {
          const stringsToWrite = logsToWrite.map((elem) => this._toString(elem))
          // Resolved per batch: a run spanning midnight rolls onto the new file
          const logfile = path.join(this._logPath, this._getLogfileName())
          await fs.writeFile(logfile, stringsToWrite.join('\n') + '\n', { flag: 'a' })
        }

        // Advanced only now that those entries are on disk. A rejected write
        // leaves the pointer on the batch it could not write, so the next append
        // retries it instead of the log quietly swallowing the entries.
        this._entryPointer = nextPointer
      }
    } catch (err: unknown) {
      this._reportWriteFailure(err)
      throw err
    }
  }

  /**
   * Returns a timestamp in the format HH:MM:SS.
   */
  _getTimestamp (): string {
    let date = new Date()
    let hour = date.getHours().toString()
    let min = date.getMinutes().toString()
    let sec = date.getSeconds().toString()
    return `${hour.padStart(2, '0')}:${min.padStart(2, '0')}:${sec.padStart(2, '0')}`
  }

  /**
   * Returns the current log file name (dynamically
   * generated when Zettlr runs overnight).
   */
  _getLogfileName (): string {
    let date = new Date()
    let year = date.getFullYear().toString()
    let month = (date.getMonth() + 1).toString()
    let day = date.getDate().toString()
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}.log`
  }

  /**
   * Converts a message to a simple string.
   * @param {LogMessage} message The message to stringify
   */
  _toString (message: LogMessage): string {
    let level = 'Verbose'
    if (message.level === LogLevel.info) {
      level = 'Info'
    }
    if (message.level === LogLevel.warning) {
      level = 'Warning'
    }
    if (message.level === LogLevel.error) {
      level = 'Error'
    }

    let details = ''
    if (message.details instanceof Error) {
      // There was an error object in the details, so stringify it
      const name = message.details.name
      const msg = message.details.message
      const stack = (message.details.stack !== undefined)
        ? message.details.stack.replace(/\n+/g, ' --> ')
        : 'No stack trace provided'
      details = ` | Native Error: ${name}; ${msg} Stack Trace: ${stack}`
    } else if (Array.isArray(message.details)) {
      details = ` | Details: ${message.details.join(', ')}`
    } else if (
      typeof message.details === 'string' ||
      typeof message.details === 'number' ||
      typeof message.details === 'boolean'
    ) {
      details = ` | Details: ${message.details}`
    } else if (
      message.details != null &&
      typeof message.details === 'object' &&
      Object.keys(message.details).length > 0
    ) {
      details = ` | Details: ${JSON.stringify(message.details)}`
    }
    // Anything else -- null, undefined, a symbol, a function -- carries no
    // detail worth a line, so it is left off rather than rendered as
    // "undefined" or "[object Object]".

    let timestamp = ('time' in message) ? `[${message.time}] ` : ''

    return `${timestamp}[${level}] ${message.message}${details}`
  }
}
