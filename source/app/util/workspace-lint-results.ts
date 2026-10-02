import type DocumentLintProvider from "@providers/document-lint";
import type { DocumentLintRecord, DocumentLintSource } from "@providers/document-lint";

/** The one cache-only workspace lint read used by the API and the Problems view. */
export async function workspaceLintRows(
  provider: Pick<DocumentLintProvider, "lookup">,
  sources: DocumentLintSource[],
): Promise<Array<{ path: string; record?: DocumentLintRecord; current: boolean }>> {
  const lookups = await provider.lookup(sources);
  return sources.map((source, index) => ({ path: source.path, ...lookups[index] }));
}
