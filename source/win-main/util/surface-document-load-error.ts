import { trans } from "@common/i18n-renderer";
import { reportError } from "@common/util/error-reporting";
import errorToString from "@common/util/error-to-string";
import { loadFromDiskAction } from "@common/util/load-document-from-disk";
import { pathBasename } from "@common/util/renderer-path-polyfill";
import showToast, { type ToastAction } from "@common/util/show-toast";

export interface DocumentLoadFailure {
  message: string;
  diagnostic: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }

  return String(error);
}

/** Writes the failure to the renderer log and shows it in the window. */
function show(filePath: string, failure: DocumentLoadFailure, action?: ToastAction): void {
  reportError(`[MainEditor] Could not load document ${filePath}\n${failure.diagnostic}`);
  showToast(
    trans('Could not load "%s": %s', pathBasename(filePath), failure.message),
    "error",
    12000,
    action,
  );
}

/**
 * Reports that the document of a file that changed on disk could not be
 * loaded again. The editor keeps the text that it has, and the message
 * offers to load the file again.
 */
export function surfaceDocumentLoadFailure(filePath: string, failure: DocumentLoadFailure): void {
  show(filePath, failure, loadFromDiskAction(filePath));
}

/**
 * Reports that an editor could not load its document. The provider holds no
 * text of that document, so the message offers the load itself again: the
 * caller gives the function that starts it.
 */
export default function surfaceDocumentLoadError(
  filePath: string,
  error: unknown,
  loadAgain: () => void,
): void {
  show(
    filePath,
    { message: errorMessage(error), diagnostic: errorToString(error) },
    { label: trans("Try again"), onAction: loadAgain },
  );
}
