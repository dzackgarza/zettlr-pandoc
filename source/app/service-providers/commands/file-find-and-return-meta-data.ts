/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        FileFindAndReturnMetaData command
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This command finds the absolute path of a file, and returns
 *                  the file's meta data
 *
 * END HEADER
 */

import { listedDocumentName } from "@common/util/document-title";
import extractYamlFrontmatter from "@common/util/extract-yaml-frontmatter";
import { type WikilinkResolution } from "@common/util/wikilink-resolution";
import { splitWikilinkTarget } from "@common/util/wikilink-target";
import type { FileNameDisplay } from "@dts/common/fsal";
import type FSAL from "source/app/service-providers/fsal";
import type LinkProvider from "source/app/service-providers/links";
import ZettlrCommand from "./zettlr-command";

const MAX_FILE_PREVIEW_LENGTH = 300;
const MAX_FILE_PREVIEW_LINES = 10;

export interface FindFileAndReturnMetadataRequest {
  linkContents: string;
  /** The document that contains the link. */
  sourcePath: string;
}

export type FindFileAndReturnMetadataResult =
  | {
      status: "resolved";
      title: string;
      filePath: string;
      previewMarkdown: string;
      wordCount: number;
      modtime: number;
    }
  | Exclude<WikilinkResolution, { status: "resolved" }>;

/** The services that the command uses. */
export interface FileMetadataServices {
  links: Pick<LinkProvider, "resolve">;
  fsal: Pick<FSAL, "getDescriptorFor" | "loadAnySupportedFile">;
  config: {
    get: () => { fileNameDisplay: FileNameDisplay; display: { markdownFileExtensions: boolean } };
  };
}

export default class FilePathFindMetaData extends ZettlrCommand<FileMetadataServices> {
  constructor(app: FileMetadataServices) {
    super(app, ["file-find-and-return-meta-data"]);
  }

  /**
   * Resolves a wikilink and returns the preview of the document it names.
   */
  async run(
    evt: string,
    arg: FindFileAndReturnMetadataRequest,
  ): Promise<FindFileAndReturnMetadataResult> {
    const { target } = splitWikilinkTarget(arg.linkContents);
    const resolution = this._app.links.resolve(target, arg.sourcePath);
    if (resolution.status !== "resolved") {
      return resolution;
    }

    const descriptor = await this._app.fsal.getDescriptorFor(resolution.path);
    if (descriptor.type !== "file") {
      throw new Error(`The wikilink target ${resolution.path} is not a Markdown file`);
    }

    const markdown = await this._app.fsal.loadAnySupportedFile(descriptor.path);
    const { content } = extractYamlFrontmatter(markdown);
    const lines = content.split("\n");

    let preview = "";
    let i = 0;
    const maxPreviewLines = Math.min(lines.length, MAX_FILE_PREVIEW_LINES);
    while (preview.length <= MAX_FILE_PREVIEW_LENGTH && i < maxPreviewLines) {
      const remainingChars = MAX_FILE_PREVIEW_LENGTH - preview.length;
      if (lines[i].length <= remainingChars) {
        preview += lines[i] + "\n";
      } else {
        preview += lines[i].slice(0, remainingChars) + "…";
      }
      i++;
    }

    const config = this._app.config.get();
    return {
      status: "resolved",
      // The name that the file manager lists for the target
      title: listedDocumentName(
        descriptor,
        config.fileNameDisplay,
        config.display.markdownFileExtensions,
      ),
      filePath: descriptor.path,
      previewMarkdown: preview,
      wordCount: descriptor.wordCount,
      modtime: descriptor.modtime,
    };
  }
}
