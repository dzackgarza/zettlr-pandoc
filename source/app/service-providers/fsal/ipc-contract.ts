/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:    FSAL IPC Contract
 * CVM-Role:    Types
 * Maintainer:  D. Zack Garza
 * License:     GNU GPL v3
 *
 * Description:     The IPC contract of the FSAL provider, owned here beside
 *                  its handlers (the module file carries pre-existing lint
 *                  debt, so the contract lives adjacent).
 *
 * END HEADER
 */

import type { AnyDescriptor } from '@dts/common/fsal'

export type FsalIPCContract = {
  'read-path-recursively': {
    request: { payload: string }
    response: string[]
  }
  'read-directory': {
    request: { payload: string }
    response: AnyDescriptor[]
  }
  'get-descriptor': {
    request: { payload: string|string[] }
    response: AnyDescriptor|AnyDescriptor[]|undefined
  }
}
