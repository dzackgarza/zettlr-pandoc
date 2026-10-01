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
import type { IgnoreRuleSources } from 'source/common/util/ignore-rules'

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
  /**
   * The ignore rules the FSAL lists with. The FSAL also sends them on the
   * channel `fsal-ignore-rules` each time they change.
   */
  'get-ignore-rules': {
    request: {}
    response: IgnoreRuleSources
  }
  /** Replaces the rules file of an open workspace. */
  'set-workspace-ignore-rules': {
    request: { payload: { root: string, text: string } }
    response: void
  }
  /** Hides one path with a rule in its workspace's rules file, or shows it again. */
  'set-path-ignored': {
    request: { payload: { path: string, isDirectory: boolean, ignored: boolean } }
    response: void
  }
}
