/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:    Update Provider IPC Contract
 * CVM-Role:    Types
 * Maintainer:  D. Zack Garza
 * License:     GNU GPL v3
 *
 * Description:     The IPC contract of the update provider, owned here beside
 *                  its handlers (the module file carries pre-existing lint
 *                  debt, so the contract lives adjacent).
 *
 * END HEADER
 */

import type { UpdateState } from './index'

export type UpdateProviderIPCContract = {
  'check-for-update': {
    request: { payload?: undefined }
    response: undefined
  }
  'update-status': {
    request: { payload?: undefined }
    response: UpdateState
  }
  'request-app-update': {
    request: { payload: string }
    response: undefined
  }
  'begin-update': {
    request: { payload?: undefined }
    response: boolean
  }
}
