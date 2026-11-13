/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        LinkProvider class
 * CVM-Role:        Service Provider
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Handles links back and forth
 *
 * END HEADER
 */

import { trans } from "@common/i18n-main";
import broadcastIpcMessage from "@common/util/broadcast-ipc-message";
import {
  movedPath,
  type PathMove,
  retargetedFileLink,
  retargetedLink,
  retargetLinks,
} from "@common/util/replace-links";
import {
  type WikilinkDocument,
  WikilinkIndex,
  type WikilinkResolution,
} from "@common/util/wikilink-resolution";
import { splitWikilinkTarget } from "@common/util/wikilink-target";
import type { WorkspaceEditProposal } from "@dts/common/workspace-edit";
import type LogProvider from "@providers/log";
import { ipcMain } from "electron";
import { existsSync } from "fs";
import path from "path";
import { proposalOf, type WorkspaceEditDocuments } from "source/app/util/workspace-edit-proposal";
import { innermostRoot } from "source/common/util/renderer-path-polyfill";
import type { MDFileDescriptor } from "source/types/common/fsal";
import _ from "underscore";
import type ConfigProvider from "../config";
import type FSAL from "../fsal";
import type { FSALEventPayload } from "../fsal";
import ProviderContract from "../provider-contract";
import type { WikilinkEdge } from "./ipc-contract";

/**
 * The links of every file and the index they resolve against: the wikilinks
 * and the URLs of the Markdown links and images that can name a file.
 */
export interface WikilinkSnapshot {
  index: WikilinkIndex;
  links: Map<string, string[]>;
  fileLinks: Map<string, string[]>;
}

/**
 * This class resolves the wikilinks of the loaded workspaces. It keeps the
 * outbound link targets of every file and the workspace's wikilink index, and
 * rebuilds both whenever the Markdown files of a workspace change.
 */
export default class LinkProvider extends ProviderContract {
  private _fileLinkDatabase: Map<string, string[]>;
  /** The URLs of the Markdown links and images of every file. */
  private _fileUrlDatabase: Map<string, string[]>;
  private _index: WikilinkIndex;
  /** What the index was built from: the comparison value of a reindex */
  private _indexEntries: WikilinkDocument[];

  constructor(
    private readonly _logger: LogProvider,
    private readonly _config: ConfigProvider,
    private readonly _fsal: FSAL,
  ) {
    super();

    this._fileLinkDatabase = new Map();
    this._fileUrlDatabase = new Map();
    this._index = new WikilinkIndex([]);
    this._indexEntries = [];

    ipcMain.handle("link-provider", async (event, message) => {
      const { command } = message;

      if (command === "get-inbound-links") {
        // Return whatever links to the given file
        const filePath: string = message.payload.filePath;
        return {
          inbound: this.retrieveInbound(filePath),
          outbound: this.retrieveOutbound(filePath),
        };
      } else if (command === "get-link-database") {
        return this.linkDatabase();
      } else if (command === "get-link-targets") {
        return this.linkTargets();
      } else if (command === "resolve-wikilinks") {
        const { sourcePath, targets } = message.payload as {
          sourcePath: string;
          targets: string[];
        };
        return Object.fromEntries(
          targets.map((target) => [target, this.resolve(target, sourcePath)]),
        );
      }
    });
  }

  public async boot(): Promise<void> {
    // Listen to state changes within the Workspaces Provider
    this._fsal.on("fsal-events", (events: FSALEventPayload[]) => {
      // Only a Markdown file has links, and only a removal has no descriptor
      // that says what it was.
      const affectsLinks = events.some(
        (payload) => "path" in payload || payload.descriptor.type === "file",
      );
      if (!affectsLinks) {
        return;
      }
      this.reindex()
        .then((changed) => {
          if (changed) {
            broadcastIpcMessage("links");
          }
        })
        .catch((err) =>
          this._logger.error(
            `[LinkProvider] Could not update the link database: ${err.message}`,
            err,
          ),
        );
    });

    // Pull in the initial update
    await this.reindex();
  }

  /**
   * Reindexes the entire link database.
   *
   * @return  {Promise<boolean>}  True when the links or the index changed
   */
  public async reindex(): Promise<boolean> {
    const descriptors = (await this._fsal.getAllLoadedDescriptors()).filter(
      (descriptor): descriptor is MDFileDescriptor => descriptor.type === "file",
    );

    // A file belongs to the innermost open workspace that contains it; a file
    // opened on its own is its own workspace.
    const workspaces = this._config.get().app.openWorkspaces;
    const rootFor = (filePath: string): string => {
      return innermostRoot(filePath, workspaces) ?? path.dirname(filePath);
    };

    const links = new Map(descriptors.map((descriptor) => [descriptor.path, descriptor.links]));
    // The windows do not read the Markdown links: a change of them alone
    // broadcasts nothing.
    this._fileUrlDatabase = new Map(
      descriptors.map((descriptor) => [descriptor.path, descriptor.fileLinks]),
    );
    const entries: WikilinkDocument[] = descriptors.map((descriptor) => ({
      path: descriptor.path,
      root: rootFor(descriptor.path),
      id: descriptor.id,
      title: descriptor.yamlTitle,
      aliases: descriptor.aliases,
    }));
    // A save that changed no link, name, id, title or alias keeps the index.
    if (
      _.isEqual(entries, this._indexEntries) &&
      _.isEqual([...links], [...this._fileLinkDatabase])
    ) {
      return false;
    }

    this._fileLinkDatabase = links;
    this._indexEntries = entries;
    this._index = new WikilinkIndex(entries);
    return true;
  }

  /**
   * Shuts down the service provider
   * @return {Boolean} Returns true after successful shutdown
   */
  async shutdown(): Promise<void> {
    this._logger.verbose("Link provider shutting down ...");
  }

  /**
   * Resolves the target of a wikilink, before its `#` fragment and `|` label,
   * written in the document at `sourcePath`.
   */
  resolve(target: string, sourcePath: string): WikilinkResolution {
    return this._index.resolve(target, sourcePath);
  }

  /** The index as it stands now; a later reindex does not change it. */
  get index(): WikilinkIndex {
    return this._index;
  }

  /** The links and the index as they stand now, to retarget after a move. */
  snapshot(): WikilinkSnapshot {
    return {
      index: this._index,
      links: this._fileLinkDatabase,
      fileLinks: this._fileUrlDatabase,
    };
  }

  /**
   * Reindexes after `move`, and returns the files, at their paths before the
   * move, that hold a link whose document the move changed: a wikilink, or a
   * Markdown link or image whose relative path no longer reaches its file.
   */
  async filesChangedByMove(before: WikilinkSnapshot, move: PathMove): Promise<string[]> {
    await this.reindex();
    const paths = new Set([...before.links.keys(), ...before.fileLinks.keys()]);
    return [...paths].filter(
      (sourcePath) =>
        (before.links.get(sourcePath) ?? []).some((link) => {
          const { target } = splitWikilinkTarget(link);
          return retargetedLink(target, sourcePath, move, before.index, this._index) !== undefined;
        }) ||
        (before.fileLinks.get(sourcePath) ?? []).some(
          (url) => retargetedFileLink(url, sourcePath, move, existsSync) !== undefined,
        ),
    );
  }

  /**
   * Reindexes after `move`, and returns the proposal that retargets the
   * links of the files that `filesChangedByMove` names, so that each names
   * the document it named before `move`; undefined when no link changes. It reads the text of an open
   * document from its buffer. Nothing changes until the author applies the
   * proposal.
   */
  async retargetProposal(
    before: WikilinkSnapshot,
    move: PathMove,
    documents: WorkspaceEditDocuments,
  ): Promise<WorkspaceEditProposal | undefined> {
    const proposed = [];
    for (const sourcePath of await this.filesChangedByMove(before, move)) {
      const documentPath = movedPath(sourcePath, move);
      const source =
        documents.readMarkdownBufferContent(documentPath) ??
        (await this._fsal.readTextFile(documentPath));
      let target = source;
      const replacements = retargetLinks(
        source,
        sourcePath,
        move,
        before.index,
        this._index,
        this._config.get().zkn.linkFormat,
        existsSync,
      );
      // From the end, so that each range is a range of the source.
      for (const { from, to, text } of replacements.reverse()) {
        target = target.slice(0, from) + text + target.slice(to);
      }
      proposed.push({ documentPath, source, target });
    }
    return proposalOf(
      trans("Update links"),
      trans(
        "%s moved to %s. These links follow it. No file changes until you apply.",
        move.from,
        move.to,
      ),
      proposed,
    );
  }

  /** The written form of a wikilink to `filePath`. */
  canonicalTarget(filePath: string): string {
    return this._index.canonical(filePath);
  }

  /** The other documents the links in `sourceFilePath` resolve to. */
  private resolvedTargets(sourceFilePath: string): string[] {
    const paths: string[] = [];
    for (const link of this._fileLinkDatabase.get(sourceFilePath) ?? []) {
      const resolution = this.resolve(splitWikilinkTarget(link).target, sourceFilePath);
      if (
        resolution.status === "resolved" &&
        resolution.path !== sourceFilePath &&
        !paths.includes(resolution.path)
      ) {
        paths.push(resolution.path);
      }
    }
    return paths;
  }

  /**
   * Retrieves a set of links to the file given as argument
   *
   * @param   {string}    sourceFilePath  The source file's path
   *
   * @return  {string[]}                  A list of all files linking to sourceFile
   */
  retrieveInbound(sourceFilePath: string): string[] {
    return [...this._fileLinkDatabase.keys()].filter((file) =>
      this.resolvedTargets(file).includes(sourceFilePath),
    );
  }

  /**
   * Retrieves a set of files the given source file links to
   *
   * @param   {string}    sourceFilePath  The source file's path
   *
   * @return  {string[]}                  A list of outbound links from source
   */
  retrieveOutbound(sourceFilePath: string): string[] {
    return this.resolvedTargets(sourceFilePath);
  }

  /**
   * Every file's links to other documents, each with the document it
   * resolves to.
   */
  private linkDatabase(): Record<string, WikilinkEdge[]> {
    const database: Record<string, WikilinkEdge[]> = {};
    for (const [sourcePath, links] of this._fileLinkDatabase) {
      database[sourcePath] = links
        .map((link) => {
          const { target } = splitWikilinkTarget(link);
          const resolution = this.resolve(target, sourcePath);
          return { target, path: resolution.status === "resolved" ? resolution.path : undefined };
        })
        .filter((edge) => edge.path !== sourcePath);
    }
    return database;
  }

  /** The written wikilink form of every file. */
  private linkTargets(): Record<string, string> {
    return Object.fromEntries(
      [...this._fileLinkDatabase.keys()].map((filePath) => [
        filePath,
        this.canonicalTarget(filePath),
      ]),
    );
  }
}
