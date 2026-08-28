/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        WindowRegistration module
 * CVM-Role:        Controller
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This module exports the windowRegister function which must
 *                  be run by every renderer process before anything else. It
 *                  will register certain globals, the necessary stylesheets and
 *                  other important assets.
 *
 * END HEADER
 */

import { loadData } from "@common/i18n-renderer";
import type { MathJaxMacro } from "@common/util/mathjax-config";
import { initializeMathJax } from "@common/util/mathtex-to-html";
import loadIcons from "./load-icons";
import registerDefaultContextMenu from "./register-default-context";
import registerThemes from "./register-themes";

/**
 * This function is the renderer's counterpart to the main process's window
 * configuration and registers stuff like custom window controls and the menu
 * bar (on Windows and Linux, if native is off)
 */
export default async function windowRegister(): Promise<void> {
  // Immediately load the translations
  await loadData();
  // Load the clarity icons
  await loadIcons();

  // Fetch the user's MathJax macros from the main process (the renderer is
  // sandboxed and cannot read the config file itself), then preload the font
  // data before synchronous document conversion begins.
  const macros = (await window.ipc.invoke("mathjax-macros")) as Record<string, MathJaxMacro>;
  await initializeMathJax(macros);

  // ... the theming functionality ...
  registerThemes();
  // ... the default context menus
  registerDefaultContextMenu();
}
