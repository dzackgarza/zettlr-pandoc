/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The editor commands by their typed name
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     One table of the editor commands, keyed by the names that
 *                  the Insert and Format menus send. The editor runs a menu
 *                  command through it, and a context menu of the editor runs
 *                  the same command on its own view (#202).
 *
 * END HEADER
 */

import { type EditorView } from "@codemirror/view";
import type { EditorCommandName } from "@dts/common/shortcut-names";
import { createReferenceLabel } from "../plugins/create-reference-label";
import { toggleReadability } from "../renderers/readability";
import { toggleLintPanel } from "../statusbar/diagnostics";
import { addNewFootnote } from "./footnotes";
import {
  applyBlockquote,
  applyBold,
  applyBulletList,
  applyCode,
  applyComment,
  applyH1,
  applyH2,
  applyH3,
  applyH4,
  applyH5,
  applyH6,
  applyItalic,
  applyOrderedList,
  applyStrikethrough,
  applyTaskList,
  insertImage,
  insertLink,
} from "./markdown";

const EDITOR_COMMANDS: Record<EditorCommandName, (view: EditorView) => boolean> = {
  markdownComment: applyComment,
  markdownLink: insertLink,
  markdownImage: insertImage,
  insertFootnote: addNewFootnote,
  markdownMakeTaskList: applyTaskList,
  createReferenceLabel,
  markdownBold: applyBold,
  markdownItalic: applyItalic,
  markdownCode: applyCode,
  markdownStrikethrough: applyStrikethrough,
  markdownHeading1: applyH1,
  markdownHeading2: applyH2,
  markdownHeading3: applyH3,
  markdownHeading4: applyH4,
  markdownHeading5: applyH5,
  markdownHeading6: applyH6,
  markdownBlockquote: applyBlockquote,
  markdownBulletList: applyBulletList,
  markdownOrderedList: applyOrderedList,
  toggleReadabilityMode: toggleReadability,
  toggleLintPanel,
};

/** Runs the editor command `name` on `view`. */
export function runEditorCommand(view: EditorView, name: EditorCommandName): boolean {
  return EDITOR_COMMANDS[name](view);
}
