/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        fontZoom
 * CVM-Role:        Utilitz function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     The exported functions from this file are used to create
 *                  callbacks for the menu which allow solely the editor font
 *                  size to be changed by the zoom items. A zoom stays in the
 *                  range of the setting: at an end it leaves the size as it is.
 *
 * END HEADER
 */

import { EDITOR_FONT_SIZE } from "../config/config-validation";
import type { MenuConfig } from "./menu-dependencies";

/**
 * Depending on the direction given, increases or decreases the font size of the
 * editor component
 *
 * @param   {ConfigProvider}  config  The configuration provider
 * @param   {'in'|'out'}      dir     The direction of zoom
 */
function fontZoom(config: MenuConfig, dir: "in" | "out"): void {
  const { fontSize } = config.get().editor;
  const next = dir === "in" ? fontSize + 1 : fontSize - 1;
  config.set(
    "editor.fontSize",
    Math.min(EDITOR_FONT_SIZE.max, Math.max(EDITOR_FONT_SIZE.min, next)),
  );
}

/**
 * Returns a function that, when called, increases the editor font size
 *
 * @param   {ConfigProvider}  config  The configuration provider
 *
 * @return  {Function}                A callback
 */
export function zoomIn(config: MenuConfig): () => void {
  return function () {
    fontZoom(config, "in");
  };
}

/**
 * Returns a function that, when called, decreases the editor font size
 *
 * @param   {ConfigProvider}  config  The configuration provider
 *
 * @return  {Function}                A callback
 */
export function zoomOut(config: MenuConfig): () => void {
  return function () {
    fontZoom(config, "out");
  };
}
