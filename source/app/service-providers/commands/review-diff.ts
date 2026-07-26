/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ReviewDiff command
 * CVM-Role:        Controller
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Opens a single supported text document in granular
 *                  accept/reject review mode from a validated unified patch.
 *
 * END HEADER
 */

import ZettlrCommand from './zettlr-command'
import type { AppServiceContainer } from 'source/app/app-service-container'
import type { ReviewDiffCliRequest } from '@dts/common/review-diff'
import { buildReviewDiffSession } from 'source/app/util/review-diff'

export default class ReviewDiff extends ZettlrCommand {
  constructor (app: AppServiceContainer) {
    super(app, 'review-diff')
  }

  async run (evt: string, arg: ReviewDiffCliRequest): Promise<boolean> {
    const session = buildReviewDiffSession(arg)
    return await this._app.documents.openReviewDiffSession(session)
  }
}
