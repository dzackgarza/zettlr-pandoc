/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        showToast function and the notification log
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     In-window notifications for renderer processes, with
 *                  the usual toast and notification-center semantics
 *                  (VS Code, GNOME, macOS): every message enters the
 *                  notification log and shows as a closable toast. The
 *                  toast times out (hovering pauses the timer) and then
 *                  folds into the log, which the notification center
 *                  shows. Dismissing a toast or a log entry removes the
 *                  message from both. While the center is open, a new
 *                  message goes to the center only. Messages never block
 *                  and never stay on screen indefinitely.
 *
 * END HEADER
 */

const CONTAINER_ID = 'zettlr-toast-container'

/**
 * One optional labeled action rendered as a real button on the toast
 * (issue #1, review A5): e.g. the committed workspace rename's Undo. The
 * action runs exactly once and dismisses the message; dismissing the
 * message any other way never runs it.
 */
export interface ToastAction {
  /** The button label, e.g. 'Undo' */
  label: string
  /** Runs when (and only when) the button is clicked */
  onAction: () => void
}

/**
 * One message in the notification log.
 */
export interface NotificationEntry {
  id: number
  kind: 'info'|'error'
  message: string
  time: Date
  action?: ToastAction
}

const entries: NotificationEntry[] = []
const visibleToasts = new Map<number, HTMLElement>()
const listeners = new Set<() => void>()
let nextId = 1
let centerOpen = false

function notifyListeners (): void {
  for (const listener of listeners) {
    listener()
  }
}

/**
 * The notification log, oldest first.
 */
export function notificationEntries (): readonly NotificationEntry[] {
  return entries
}

/**
 * Calls the listener after every change to the log. Returns the
 * unsubscribe function.
 */
export function onNotificationsChanged (listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Tells the log whether the notification center is open. Opening the
 * center moves every visible toast into it; while it is open, new messages
 * show in the center and not as toasts.
 */
export function setNotificationCenterOpen (open: boolean): void {
  centerOpen = open
  if (open) {
    for (const toast of visibleToasts.values()) {
      toast.remove()
    }
    visibleToasts.clear()
  }
}

/**
 * Removes one message from the log and its toast from the screen.
 */
export function dismissNotification (id: number): void {
  visibleToasts.get(id)?.remove()
  visibleToasts.delete(id)
  const index = entries.findIndex(entry => entry.id === id)
  if (index !== -1) {
    entries.splice(index, 1)
  }
  notifyListeners()
}

/**
 * Removes every message from the log and every toast from the screen.
 */
export function dismissAllNotifications (): void {
  for (const toast of visibleToasts.values()) {
    toast.remove()
  }
  visibleToasts.clear()
  entries.splice(0, entries.length)
  notifyListeners()
}

/**
 * Runs the action of one message and dismisses the message.
 */
export function runNotificationAction (id: number): void {
  const entry = entries.find(entry => entry.id === id)
  if (entry?.action === undefined) {
    throw new Error(`Notification ${id} has no action`)
  }
  dismissNotification(id)
  entry.action.onAction()
}

/**
 * Copies the message text to the clipboard and reports the result on the
 * button.
 */
export function copyNotificationText (message: string, button: HTMLButtonElement): void {
  void Promise.resolve().then(() => navigator.clipboard.writeText(message)).then(() => {
    button.textContent = 'Copied'
  }, (error: Error) => {
    button.textContent = `Copy failed: ${error.message}`
  })
}

/**
 * Returns (creating on first use) the fixed toast container.
 */
function toastContainer (): HTMLElement {
  let container = document.getElementById(CONTAINER_ID)
  if (container === null) {
    container = document.createElement('div')
    container.id = CONTAINER_ID
    container.style.cssText = [
      'position: fixed', 'right: 16px', 'bottom: 36px', 'z-index: 1000',
      'display: flex', 'flex-direction: column', 'gap: 8px', 'width: min(600px, calc(100vw - 32px))'
    ].join(';')
    document.body.appendChild(container)
  }
  return container
}

function renderToast (entry: NotificationEntry, timeout: number): HTMLElement {
  const toast = document.createElement('div')
  toast.className = `zettlr-toast ${entry.kind}`
  toast.setAttribute('role', 'status')
  toast.style.cssText = [
    'display: flex', 'align-items: baseline', 'gap: 10px',
    'padding: 10px 14px', 'border-radius: 8px', 'max-height: 60vh',
    'overflow: auto', 'user-select: text', '-webkit-user-select: text',
    'box-shadow: 0 8px 24px rgba(0, 0, 0, .25)',
    'font: 13px/1.4 system-ui, sans-serif',
    entry.kind === 'error'
      ? 'background: #5c2a23; color: #f6dedb; border: 1px solid #8a4a40'
      : 'background: #2d3136; color: #eef0f2; border: 1px solid #42474d'
  ].join(';')

  const text = document.createElement('span')
  text.textContent = entry.message
  text.style.cssText = 'flex: 1 1 auto; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; -webkit-user-select: text'
  toast.append(text)

  if (entry.kind === 'error') {
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.textContent = 'Copy'
    copy.setAttribute('data-toast-copy', '')
    copy.style.cssText = 'flex: 0 0 auto; color: inherit; background: transparent; border: 1px solid currentColor; border-radius: 6px; cursor: pointer; font: inherit'
    copy.addEventListener('click', () => { copyNotificationText(entry.message, copy) })
    toast.append(copy)
  }

  if (entry.action !== undefined) {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('data-toast-action', '')
    button.textContent = entry.action.label
    button.style.cssText = [
      'flex: 0 0 auto', 'padding: 3px 10px', 'color: inherit',
      'background: rgba(255, 255, 255, .08)',
      'border: 1px solid currentColor', 'border-radius: 6px',
      'font: inherit', 'cursor: pointer'
    ].join(';')
    button.addEventListener('click', () => { runNotificationAction(entry.id) })
    toast.append(button)
  }

  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = '✕'
  close.setAttribute('aria-label', 'Dismiss')
  close.style.cssText = 'flex: 0 0 auto; opacity: .7; color: inherit; background: transparent; border: 0; cursor: pointer; font: inherit'
  close.addEventListener('click', () => { dismissNotification(entry.id) })
  toast.append(close)

  // At the timeout the toast folds into the notification center: it leaves
  // the screen, and its entry stays in the log.
  let timer: ReturnType<typeof setTimeout>|undefined
  const fold = (): void => {
    toast.remove()
    visibleToasts.delete(entry.id)
  }
  const startTimer = (): void => { timer = setTimeout(fold, timeout) }
  toast.addEventListener('mouseenter', () => { clearTimeout(timer) })
  toast.addEventListener('mouseleave', startTimer)
  startTimer()

  return toast
}

/**
 * Adds one message to the notification log and, while the notification
 * center is closed, shows it as a toast for `timeout` ms. The message text
 * stays selectable.
 *
 * @param   {string}                     message  The message to show
 * @param   {'info'|'error'}             kind     The visual severity
 * @param   {number}                     timeout  Toast display time in ms
 * @param   {ToastAction}                action   Optional labeled action button
 */
export default function showToast (message: string, kind: 'info'|'error' = 'info', timeout = 6000, action?: ToastAction): void {
  const entry: NotificationEntry = { id: nextId++, kind, message, time: new Date(), action }
  entries.push(entry)
  if (!centerOpen) {
    const toast = renderToast(entry, timeout)
    visibleToasts.set(entry.id, toast)
    toastContainer().appendChild(toast)
  }
  notifyListeners()
}
