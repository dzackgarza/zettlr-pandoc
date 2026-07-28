import { trans } from '@common/i18n-renderer'
import errorToString from '@common/util/error-to-string'
import { pathBasename } from '@common/util/renderer-path-polyfill'
import showToast from '@common/util/show-toast'

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message
  }

  return String(error)
}

/**
 * Reports a recoverable document-load failure to both durable renderer logs
 * and the visible in-window error surface.
 */
export default function surfaceDocumentLoadError(
  filePath: string,
  error: unknown
): void {
  console.error(
    `[MainEditor] Could not load document ${filePath}\n${errorToString(error)}`
  )
  showToast(
    trans(
      'Could not load "%s": %s',
      pathBasename(filePath),
      errorMessage(error)
    ),
    'error',
    12000
  )
}
