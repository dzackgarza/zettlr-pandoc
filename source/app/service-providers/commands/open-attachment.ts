/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        OpenAttachment command
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This command opens the first attachment file that the
 *                  library names for a cite key and that is on disk, or
 *                  else the first PDF that Zotero has for the key. When
 *                  neither gives a file, it throws with the cause.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-main";
import type CiteprocProvider from "@providers/citeproc";
import type DocumentManager from "@providers/documents";
import type FSAL from "@providers/fsal";
import type LogProvider from "@providers/log";
import ky from "ky";
import { documentBibliography } from "source/app/util/document-bibliographies";
import { openPath } from "source/app/util/open-path";
import ZettlrCommand from "./zettlr-command";

/** The services that the command uses. */
export interface OpenAttachmentServices {
  log: Pick<LogProvider, "warning">;
  documents: Pick<DocumentManager, "readDocumentText">;
  fsal: Pick<FSAL, "getAnyDirectoryDescriptor">;
  citeproc: Pick<
    CiteprocProvider,
    "loadDatabases" | "hasBibTexAttachments" | "getBibTexAttachments"
  >;
  /** The origin of the Zotero local server. */
  config: { get: () => { zotero: { localServer: string } } };
}

export default class OpenAttachment extends ZettlrCommand<OpenAttachmentServices> {
  constructor(app: OpenAttachmentServices) {
    super(app, "open-attachment");
  }

  /**
   * Attempt to open a PDF (or other) attachment for a given citekey.
   *
   * @param  {string}  evt The event name
   * @param  {any}     arg An object containing the citekey to open.
   */
  async run(evt: string, arg: { filePath: string; citekey: string }): Promise<boolean> {
    if (!("citekey" in arg) || typeof arg.citekey !== "string") {
      return false;
    }

    // The libraries of the document, as the editor that shows the citation
    // has them (#198).
    const text = await this._app.documents.readDocumentText(arg.filePath);
    const { database: library } = await documentBibliography(this._app.fsal, arg.filePath, text);
    await this._app.citeproc.loadDatabases(library);

    let libraryNamesNoFile = false;

    // First let's see if we've got BibTex attachments, so we can
    // circumvent the Zotero thing directly
    if (this._app.citeproc.hasBibTexAttachments(library)) {
      const attachments = this._app.citeproc.getBibTexAttachments(library, arg.citekey);
      if (attachments === false) {
        libraryNamesNoFile = true;
      } else if (attachments.length === 0) {
        // The library names files for this key, and none is on disk. Zotero
        // knows where its files are, so the query below is the next source.
        this._app.log.warning(
          `No attachment file that the library names for ${arg.citekey} is on disk. Asking Zotero.`,
        );
      } else {
        // A refusal names the file; the dispatcher shows it.
        await openPath(attachments[0]);
        return true;
      }
    }

    // The library names files for the key, but none is on disk, or the
    // library names none: Zotero knows the PDFs of its items.
    const pdf = await this.zoteroPdf(arg.citekey).catch((rejection: Error) => {
      const cause = libraryNamesNoFile
        ? trans("the library names no file for it, and %s", rejection.message)
        : rejection.message;
      throw new Error(trans("Could not open an attachment of %s: %s.", arg.citekey, cause));
    });

    // A refusal names the file; the dispatcher shows it.
    await openPath(pdf);
    return true;
  }

  /**
   * The first PDF that Zotero has for a cite key, through the JSON-RPC API of
   * Better BibTeX. It rejects with the cause when Zotero does not answer,
   * answers an error, or has no PDF for the key.
   *
   * @param   {string}  citekey  The cite key
   *
   * @return  {Promise<string>}  The path of the PDF
   */
  private async zoteroPdf(citekey: string): Promise<string> {
    // The JSON-RPC API of Better BibTeX, on Zotero's local server.
    const endpoint = new URL("/better-bibtex/json-rpc", this._app.config.get().zotero.localServer);
    const res: unknown = await ky
      .post(endpoint, {
        json: {
          jsonrpc: "2.0",
          method: "item.attachments",
          // NOTE: The second parameter means that we wish to search across all
          // libraries (not just the user library, but all groups, too). This
          // allows Zettlr to retrieve items that have been exported from a
          // group library, too.
          // See BBT docs: https://retorque.re/zotero-better-bibtex/exporting/json-rpc/index.html
          // See issue #5647
          params: [citekey, "*"],
        },
      })
      .json()
      .catch((err: Error) => {
        const reason = err.cause instanceof Error ? err.cause.message : err.message;
        throw new Error(trans("Zotero did not answer at %s: %s", endpoint.href, reason));
      });

    if (typeof res !== "object" || res === null) {
      throw new Error(trans("Better BibTeX gave no answer object"));
    }
    if ("error" in res) {
      const error = res.error;
      const message =
        typeof error === "object" && error !== null && "message" in error
          ? String(error.message)
          : JSON.stringify(error);
      throw new Error(trans("Zotero answered: %s", message));
    }
    if (
      !("result" in res) ||
      !Array.isArray(res.result) ||
      !res.result.every(
        (r: unknown) =>
          typeof r === "object" && r !== null && "path" in r && typeof r.path === "string",
      )
    ) {
      throw new Error(trans("Better BibTeX gave an answer without a list of attachments"));
    }

    const result = res.result as Array<{ path: string }>;
    const pdfAttachments = result
      .filter((elem) => elem.path.toLowerCase().endsWith(".pdf"))
      .map((elem) => elem.path);
    if (pdfAttachments.length === 0) {
      throw new Error(trans("Zotero has no PDF for it"));
    }
    if (pdfAttachments.length > 1) {
      // The log shows which one opens when the opener opens the wrong one.
      this._app.log.warning(
        "There was more than one PDF attachment. Opening only the first one.",
        pdfAttachments,
      );
    }
    return pdfAttachments[0];
  }
}
