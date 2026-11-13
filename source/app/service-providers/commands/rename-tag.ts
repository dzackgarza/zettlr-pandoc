/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        RenameTag command
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This command offers the rename of a tag across all files:
 *                  it sends the window the proposal of the edit of each file
 *                  that has the tag. No file changes until the author
 *                  applies it, and then each file changes or none does.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-main";
import replaceTags from "@common/util/replace-tags";
import type { MDFileDescriptor } from "@dts/common/fsal";
import type { AppServiceContainer } from "source/app/app-service-container";
import { proposalOf } from "source/app/util/workspace-edit-proposal";
import ZettlrCommand from "./zettlr-command";

export default class RenameTag extends ZettlrCommand {
  constructor(app: AppServiceContainer) {
    super(app, "rename-tag");
  }

  /**
   * Proposes the replacement of a tag in each file that has it. The text of
   * an open document is the text of its buffer.
   *
   * @param {String} evt The event name
   * @param  {Object} arg The old and the new name of the tag.
   * @return {boolean} Whether a file has the tag; then the window shows the edit.
   */
  async run(evt: string, arg: { oldName: string; newName: string }): Promise<boolean> {
    const oldName: string = arg.oldName;
    const newName: string = arg.newName.trim();
    if (newName === "") {
      throw new Error(trans('The tag "%s" needs a new name.', oldName));
    }

    const relevantFiles = (await this._app.fsal.getAllLoadedDescriptors()).filter(
      (d): d is MDFileDescriptor => d.type === "file" && d.tags.includes(oldName),
    );

    const documents = [];
    for (const file of relevantFiles) {
      const source =
        this._app.documents.readMarkdownBufferContent(file.path) ??
        (await this._app.fsal.readTextFile(file.path));
      documents.push({
        documentPath: file.path,
        source,
        target: replaceTags(source, oldName, newName),
      });
    }

    const proposal = proposalOf(
      trans("Rename tag"),
      trans(
        'The tag "%s" becomes "%s" in these files. No file changes until you apply.',
        oldName,
        newName,
      ),
      documents,
    );
    if (proposal === undefined) {
      return false;
    }
    this._app.commands.propose(proposal);
    return true;
  }
}
