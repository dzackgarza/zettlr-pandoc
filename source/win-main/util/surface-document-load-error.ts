import { trans } from '@common/i18n-renderer'
import errorToString from '@common/util/error-to-string'
import { pathBasename } from '@common/util/renderer-path-polyfill'
import showToast from '@common/util/show-toast'

export interface DocumentLoadFailure {
  message: string
  diagnostic: string
}

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
export function surfaceDocumentLoadFailure(
  filePath: string,
  failure: DocumentLoadFailure
): void {
  console.error(
    `[MainEditor] Could not load document ${filePath}\n${failure.diagnostic}`
  )
  showToast(
    trans(
      'Could not load "%s": %s',
      pathBasename(filePath),
      failure.message
    ),
    'error',
    12000
  )
}

export default function surfaceDocumentLoadError(
  filePath: string,
  error: unknown
): void {
  surfaceDocumentLoadFailure(filePath, {
    message: errorMessage(error),
    diagnostic: errorToString(error)
  })
}
