/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:    Link Provider IPC Contract
 * CVM-Role:    Types
 * Maintainer:  D. Zack Garza
 * License:     GNU GPL v3
 *
 * Description:     The IPC contract of the link provider, owned here beside
 *                  its handlers (the module file carries pre-existing lint
 *                  debt, so the contract lives adjacent).
 *
 * END HEADER
 */

export type LinkProviderIPCContract = {
  'get-inbound-links': {
    request: { payload: { filePath: string } }
    response: { inbound: string[], outbound: string[] }
  }
  'get-link-database': {
    request: { payload?: undefined }
    response: Record<string, string[]>
  }
}
