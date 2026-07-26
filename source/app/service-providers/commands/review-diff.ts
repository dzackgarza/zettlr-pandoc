/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ReviewDiff command
 * CVM-Role:        Controller
 * Maintainer:      D. Zack Garza
 * License:          GNU GPL v3
 *
 * Description:     Opens a single supported text document in granular
 *                  accept/reject review mode from a validated unified patch.
 *
 *                  Per spec section 14: this command is now a thin wrapper
 *                  over the new agent API. It resolves/opens the document,
 *                  obtains a live snapshot, submits the patch via
 *                  DocumentManager.submitProposal, and returns a meaningful
 *                  status to the caller. It no longer contains a separate
 *                  review implementation.
 *
 * END HEADER
 */

import ZettlrCommand from './zettlr-command'
import type { AppServiceContainer } from 'source/app/app-service-container'
import type { ReviewDiffCliRequest } from '@dts/common/review-diff'
import { readFileSync } from 'fs'
import { randomUUID } from 'crypto'

export default class ReviewDiff extends ZettlrCommand {
  constructor (app: AppServiceContainer) {
    super(app, 'review-diff')
  }

  async run (evt: string, arg: ReviewDiffCliRequest): Promise<boolean> {
    // 1. Resolve or open the document
    const filePath = arg.documentPath
    let docId = this._app.documents.getDocumentId(filePath)
    if (docId === undefined) {
      // Document is not yet loaded — load it
      await this._app.documents.getDocument(filePath)
      docId = this._app.documents.getDocumentId(filePath)
      if (docId === undefined) {
        console.error('review-diff: could not load document')
        return false
      }
    }

    // 2. Obtain a live snapshot
    const snapshot = this._app.documents.createSnapshot(docId)
    if (snapshot === undefined) {
      console.error('review-diff: could not create snapshot')
      return false
    }

    // 3. Read the patch file
    const patch = readFileSync(arg.patchPath, 'utf8')

    // 4. Submit the patch via the agent API path (submitProposal)
    const result = await this._app.documents.submitProposal(
      snapshot.token,
      patch,
      randomUUID(),
      arg.description,
    )

    // 5. Return a meaningful status to the caller
    if (!result.ok) {
      console.error(`review-diff: ${result.code} — ${result.message}`)
      return false
    }

    // Show the window so the user can review the proposal
    this._app.windows.showAnyWindow()
    return true
  }
}
