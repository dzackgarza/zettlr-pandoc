/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:    Tag Provider IPC Contract
 * CVM-Role:    Types
 * Maintainer:  D. Zack Garza
 * License:     GNU GPL v3
 *
 * Description:     The IPC contract of the tag provider, owned here beside its
 *                  handlers (the module file carries pre-existing lint debt,
 *                  so the contract lives adjacent).
 *
 * END HEADER
 */

import type { ColoredTag, TagRecord } from './index'

export type TagProviderIPCContract = {
  'get-all-tags': {
    request: { payload?: undefined }
    response: TagRecord[]
  }
  'get-colored-tags': {
    request: { payload?: undefined }
    response: ColoredTag[]
  }
  'set-colored-tags': {
    request: { payload: ColoredTag[] }
    response: undefined
  }
}
