/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:    Target Provider IPC Contract
 * CVM-Role:    Types
 * Maintainer:  D. Zack Garza
 * License:     GNU GPL v3
 *
 * Description:     The IPC contract of the targets provider, owned here beside
 *                  its handlers (the module file carries pre-existing lint
 *                  debt, so the contract lives adjacent).
 *
 * END HEADER
 */

import type { WritingTarget } from './index'

export type TargetProviderIPCContract = {
  'get-targets': {
    request: { payload?: undefined }
    response: WritingTarget[]
  }
  'set-writing-target': {
    request: { payload: WritingTarget }
    response: void
  }
}
