/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:    Appearance Provider IPC Contract
 * CVM-Role:    Types
 * Maintainer:  D. Zack Garza
 * License:     GNU GPL v3
 *
 * Description:     The IPC contract of the appearance provider, owned here
 *                  beside its handlers (the module file carries pre-existing
 *                  lint debt, so the contract lives adjacent).
 *
 * END HEADER
 */

export type AppearanceProviderIPCContract = {
  "get-accent-color": {
    request: { payload?: undefined };
    response: { accent: string; contrast: string };
  };
};
