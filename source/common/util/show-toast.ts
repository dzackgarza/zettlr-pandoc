/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        showToast function
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A minimal closable in-window toast for renderer
 *                  processes (issue #1): recoverable reference-workspace
 *                  outcomes surface here as structured, dismissable
 *                  messages — never as blocking dialogs and never as
 *                  uncloseable overlays.
 *
 * END HEADER
 */

const CONTAINER_ID = 'zettlr-toast-container'

/**
 * Returns (creating on first use) the fixed toast container.
 */
function toastContainer (): HTMLElement {
  let container = document.getElementById(CONTAINER_ID)
  if (container === null) {
    container = document.createElement('div')
    container.id = CONTAINER_ID
    container.style.cssText = [
      'position: fixed', 'right: 16px', 'bottom: 16px', 'z-index: 1000',
      'display: flex', 'flex-direction: column', 'gap: 8px', 'width: min(600px, calc(100vw - 32px))'
    ].join(';')
    document.body.appendChild(container)
  }
  return container
}

/**
 * One optional labeled action rendered as a real button on the toast
 * (issue #1, review A5): e.g. the committed workspace rename's Undo. The
 * action runs exactly once and dismisses the toast; dismissing the toast
 * any other way never runs it.
 */
export interface ToastAction {
  /** The button label, e.g. 'Undo' */
  label: string
  /** Runs when (and only when) the button is clicked */
  onAction: () => void
}

/**
 * Shows one closable toast. Error messages remain until dismissed. Other
 * messages use the supplied timeout. The message itself stays selectable.
 *
 * @param   {string}                     message  The message to show
 * @param   {'info'|'error'}             kind     The visual severity
 * @param   {number}                     timeout  Auto-dismiss delay in ms
 * @param   {ToastAction}                action   Optional labeled action button
 */
export default function showToast (message: string, kind: 'info'|'error' = 'info', timeout = 6000, action?: ToastAction): void {
  const toast = document.createElement('div')
  toast.className = `zettlr-toast ${kind}`
  toast.setAttribute('role', 'status')
  toast.style.cssText = [
    'display: flex', 'align-items: baseline', 'gap: 10px',
    'padding: 10px 14px', 'border-radius: 8px', 'max-height: 60vh',
    'overflow: auto', 'user-select: text', '-webkit-user-select: text',
    'box-shadow: 0 8px 24px rgba(0, 0, 0, .25)',
    'font: 13px/1.4 system-ui, sans-serif',
    kind === 'error'
      ? 'background: #5c2a23; color: #f6dedb; border: 1px solid #8a4a40'
      : 'background: #2d3136; color: #eef0f2; border: 1px solid #42474d'
  ].join(';')

  const text = document.createElement('span')
  text.textContent = message
  text.style.cssText = 'flex: 1 1 auto; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; -webkit-user-select: text'

  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = '✕'
  close.setAttribute('aria-label', 'Dismiss')
  close.style.cssText = 'flex: 0 0 auto; opacity: .7; color: inherit; background: transparent; border: 0; cursor: pointer; font: inherit'

  let timer: ReturnType<typeof setTimeout>|undefined
  const dismiss = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    toast.remove()
  }
  close.addEventListener('click', dismiss)

  if (kind === 'error') {
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.textContent = 'Copy'
    copy.setAttribute('data-toast-copy', '')
    copy.style.cssText = 'flex: 0 0 auto; color: inherit; background: transparent; border: 1px solid currentColor; border-radius: 6px; cursor: pointer; font: inherit'
    copy.addEventListener('click', () => {
      void Promise.resolve().then(() => navigator.clipboard.writeText(message)).then(() => {
        copy.textContent = 'Copied'
      }, (error: Error) => {
        copy.textContent = `Copy failed: ${error.message}`
      })
    })
    toast.appendChild(copy)
  }

  if (action !== undefined) {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('data-toast-action', '')
    button.textContent = action.label
    button.style.cssText = [
      'flex: 0 0 auto', 'padding: 3px 10px', 'color: inherit',
      'background: rgba(255, 255, 255, .08)',
      'border: 1px solid currentColor', 'border-radius: 6px',
      'font: inherit', 'cursor: pointer'
    ].join(';')
    button.addEventListener('click', () => {
      dismiss()
      action.onAction()
    })
    toast.prepend(text)
    toast.append(button, close)
  } else {
    toast.prepend(text)
    toast.append(close)
  }

  if (kind !== 'error' && timeout > 0) timer = setTimeout(dismiss, timeout)

  toastContainer().appendChild(toast)
}
