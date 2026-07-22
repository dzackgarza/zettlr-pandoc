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
      'display: flex', 'flex-direction: column', 'gap: 8px', 'max-width: 360px'
    ].join(';')
    document.body.appendChild(container)
  }
  return container
}

/**
 * Shows one closable toast. The toast dismisses itself after the timeout or
 * immediately on click.
 *
 * @param   {string}                     message  The message to show
 * @param   {'info'|'error'}             kind     The visual severity
 * @param   {number}                     timeout  Auto-dismiss delay in ms
 */
export default function showToast (message: string, kind: 'info'|'error' = 'info', timeout = 6000): void {
  const toast = document.createElement('div')
  toast.className = `zettlr-toast ${kind}`
  toast.setAttribute('role', 'status')
  toast.style.cssText = [
    'display: flex', 'align-items: baseline', 'gap: 10px',
    'padding: 10px 14px', 'border-radius: 8px', 'cursor: pointer',
    'box-shadow: 0 8px 24px rgba(0, 0, 0, .25)',
    'font: 13px/1.4 system-ui, sans-serif',
    kind === 'error'
      ? 'background: #5c2a23; color: #f6dedb; border: 1px solid #8a4a40'
      : 'background: #2d3136; color: #eef0f2; border: 1px solid #42474d'
  ].join(';')

  const text = document.createElement('span')
  text.textContent = message
  text.style.cssText = 'flex: 1 1 auto'

  const close = document.createElement('span')
  close.textContent = '✕'
  close.setAttribute('aria-label', 'Dismiss')
  close.style.cssText = 'flex: 0 0 auto; opacity: .7'

  toast.append(text, close)

  const dismiss = (): void => { toast.remove() }
  toast.addEventListener('click', dismiss)
  setTimeout(dismiss, timeout)

  toastContainer().appendChild(toast)
}
