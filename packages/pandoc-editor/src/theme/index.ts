/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Themes
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Zettlr editor themes.
 *
 * END HEADER
 */

import { codeTheme } from "./code";
import { editorTheme } from "./editor";

export { darkMode, useDarkModeEditor } from "./dark-mode";

export { themeBerlinDark, themeBerlinLight } from "./themes/berlin";
export { themeBielefeldDark, themeBielefeldLight } from "./themes/bielefeld";
export { themeBordeauxDark, themeBordeauxLight } from "./themes/bordeaux";
export { themeFrankfurtDark, themeFrankfurtLight } from "./themes/frankfurt";
export { themeKarlMarxStadtDark, themeKarlMarxStadtLight } from "./themes/karl-marx-stadt";

export const mainThemes = [editorTheme, codeTheme];
