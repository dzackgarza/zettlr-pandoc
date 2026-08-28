/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:    Stats Provider IPC Contract
 * CVM-Role:    Types
 * Maintainer:  D. Zack Garza
 * License:     GNU GPL v3
 *
 * Description:     The IPC contract of the stats provider, owned here beside
 *                  its handlers (the module file carries pre-existing lint
 *                  debt, so the contract lives adjacent).
 *
 * END HEADER
 */

import type { Stats } from './index'

export type StatsProviderIPCContract = {
  'get-data': {
    request: { payload?: undefined }
    response: Stats
  }
}
