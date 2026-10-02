/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:    Menu Provider IPC Contract
 * CVM-Role:    Types
 * Maintainer:  D. Zack Garza
 * License:     GNU GPL v3
 *
 * Description:     The IPC contract of the menu provider, owned here beside
 *                  its handlers (the module file carries pre-existing lint
 *                  debt, so the contract lives adjacent).
 *
 * END HEADER
 */

import type { MenuItemConstructorOptions } from "electron";

/** The menu tree is an opaque serialized structure the provider validates. */
export type MenuProviderIPCContract = {
  "display-native-context-menu": {
    request: { payload: { menu: MenuItemConstructorOptions[]; x: number; y: number } };
    response: string | undefined;
  };
};
