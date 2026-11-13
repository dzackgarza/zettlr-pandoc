/**
 * The citation database of a document, for a window: the main process owns
 * the answer (`documentBibliography`, #198), from the buffer text of an open
 * document or the file of a closed one.
 */

import type { CitationDatabase } from "@dts/common/citeproc";

/**
 * The requests that run, by document path. The Annotations view draws each
 * card of a document at the same time; they share one request. A settled
 * request leaves the map, so the next call reads the current answer.
 */
const running = new Map<string, Promise<CitationDatabase>>();

export async function documentCitationDatabase(documentPath: string): Promise<CitationDatabase> {
  const pending = running.get(documentPath);
  if (pending !== undefined) {
    return await pending;
  }
  const request: Promise<CitationDatabase> = window.ipc
    .invoke("application", { command: "get-document-bibliography", payload: documentPath })
    .finally(() => running.delete(documentPath));
  running.set(documentPath, request);
  return await request;
}
