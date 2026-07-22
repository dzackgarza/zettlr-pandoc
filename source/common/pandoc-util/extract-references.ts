/**
 * Extracts the reference surface (definitions and occurrences) of a single
 * markdown document into a typed snapshot (issue #1).
 *
 * This module runs in both the main process (FSAL saved snapshots) and the
 * renderer (live buffer replacement), so it must stay renderer-safe: no Node
 * built-ins and no CodeMirror imports.
 */

import type { DocumentReferenceSnapshot } from '../../types/common/references'

/**
 * Computes the deterministic content hash used to key reference snapshots
 * and to gate workspace edits. FNV-1a (32 bit) over UTF-16 code units:
 * dependency-free and identical in main and renderer processes.
 *
 * @param   {string}  markdown  The full markdown source
 *
 * @return  {string}            The hash, e.g. 'fnv1a-811c9dc5'
 */
export function hashDocumentSource (markdown: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < markdown.length; i++) {
    hash ^= markdown.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return 'fnv1a-' + (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Extracts every supported reference definition and occurrence from the
 * given document, in document order, with exact authored ranges.
 *
 * @param   {string}  documentPath  The document's path (snapshot identity)
 * @param   {string}  markdown      The full markdown source
 *
 * @return  {DocumentReferenceSnapshot}  The typed reference snapshot
 */
export function extractReferences (documentPath: string, markdown: string): DocumentReferenceSnapshot {
  // Definition and occurrence extraction lands with the green commit for issue #1.
  return {
    documentPath,
    sourceHash: hashDocumentSource(markdown),
    definitions: [],
    occurrences: []
  }
}
