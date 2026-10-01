/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ZoteroLibrary
 * CVM-Role:        Model
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The Zotero operations of the agent API. A search reads
 *                  Zotero's local API. An import goes to the local-write-api
 *                  add-on (https://github.com/dzackgarza/zotero-local-write-api):
 *                  Zotero identifies the source itself, and the add-on returns
 *                  the Better BibTeX citation key. An import answers after the
 *                  key is in the main citation database, which is the Better
 *                  BibTeX auto-export of the library.
 *
 * END HEADER
 */

import type CiteprocProvider from "@providers/citeproc";
import type {
  AgentErrorCode,
  ZoteroAddedItem,
  ZoteroIdentifierImportRequest,
  ZoteroIdentifierImportResponse,
  ZoteroSearchItem,
  ZoteroSearchResponse,
  ZoteroSourceRemediation,
  ZoteroUrlImportRequest,
  ZoteroUrlImportResponse,
} from "@dts/common/agent-api";

/** Zotero's local HTTP server, at the default of its httpServer.port preference. */
const ZOTERO_ORIGIN = "http://127.0.0.1:23119";

/**
 * How long an import waits for its key to reach the main citation database.
 * Better BibTeX exports the library some seconds after a change, and the
 * citation watcher reloads the file one second after the write ends.
 */
const CITABLE_DEADLINE_MS = 30000;

export type ZoteroResult<Body> =
  | { ok: true; body: Body }
  | {
      ok: false;
      status: number;
      code: AgentErrorCode;
      message: string;
      remediation?: ZoteroSourceRemediation;
    };

/** The fields of an item that Zotero's local API returns and the search reads. */
interface ZoteroApiItem {
  data: {
    key: string;
    itemType: string;
    citationKey?: string;
    title?: string;
    creators: ZoteroSearchItem["creators"];
    date?: string;
    DOI?: string;
    url?: string;
    tags: Array<{ tag: string }>;
  };
}

/** The add-on's error body (ErrorResponse in its openapi.yaml). */
interface AddonError {
  stage: string;
  error: string;
  details: {
    remediation?: {
      message: string;
      alternative_sources: Array<{ name: string; example: string }>;
    };
  };
}

/** The add-on operations this API sends to POST /write. */
type AddonWriteRequest =
  | { operation: "import_by_identifier"; identifier: string; collection_keys?: string[] }
  | {
      operation: "import_from_url";
      url: string;
      collection_keys?: string[];
      fallback_metadata?: {
        title: string;
        year: string;
        creators: Array<{ last_name: string; first_name?: string }>;
      };
    };

interface AddonIdentifierImport {
  item_keys: string[];
  citation_keys: string[];
}

interface AddonUrlImport {
  item_key: string;
  citation_key: string;
  existing: boolean;
  method: ZoteroUrlImportResponse["method"];
  details: {
    final_url: string;
    attachment_failures: ZoteroUrlImportResponse["attachmentFailures"];
  };
}

export default class ZoteroLibrary {
  constructor(readonly citeproc: CiteprocProvider) {}

  async search(query: string, limit: number): Promise<ZoteroResult<ZoteroSearchResponse>> {
    const url = new URL("/api/users/0/items/top", ZOTERO_ORIGIN);
    url.search = new URLSearchParams({
      q: query,
      limit: String(limit),
      itemType: "-attachment",
      sort: "dateAdded",
      direction: "desc",
    }).toString();
    const response = await this.request<ZoteroApiItem[]>(url, undefined);
    if (!response.ok) {
      return response;
    }
    const items = response.body.filter((item) => item.data.itemType !== "note");
    const results: ZoteroSearchItem[] = [];
    for (const { data } of items) {
      if (data.citationKey === undefined || data.citationKey.length === 0) {
        return {
          ok: false,
          status: 502,
          code: "ZOTERO_REQUEST_FAILED",
          message: `Zotero item ${data.key} has no citation key; Better BibTeX keys every regular item`,
        };
      }
      results.push({
        itemKey: data.key,
        itemType: data.itemType,
        citationKey: data.citationKey,
        title: data.title,
        creators: data.creators,
        date: data.date,
        DOI: data.DOI,
        url: data.url,
        tags: data.tags.map((tag) => tag.tag),
        citable: this.citeproc.mainLibraryHas(data.citationKey),
      });
    }
    return { ok: true, body: { items: results } };
  }

  async importIdentifier(
    request: ZoteroIdentifierImportRequest,
  ): Promise<ZoteroResult<ZoteroIdentifierImportResponse>> {
    const response = await this.write<AddonIdentifierImport>({
      operation: "import_by_identifier",
      identifier: request.identifier,
      collection_keys: request.collectionKeys,
    });
    if (!response.ok) {
      return response;
    }
    const body = response.body;
    const items = await Promise.all(
      body.item_keys.map((itemKey, index) => this.addedItem(itemKey, body.citation_keys[index])),
    );
    return { ok: true, body: { items } };
  }

  async importUrl(request: ZoteroUrlImportRequest): Promise<ZoteroResult<ZoteroUrlImportResponse>> {
    const fallback = request.fallbackMetadata;
    const response = await this.write<AddonUrlImport>({
      operation: "import_from_url",
      url: request.url,
      collection_keys: request.collectionKeys,
      ...(fallback === undefined
        ? {}
        : {
            fallback_metadata: {
              title: fallback.title,
              year: fallback.year,
              creators: fallback.creators.map((creator) => ({
                last_name: creator.lastName,
                ...(creator.firstName === undefined ? {} : { first_name: creator.firstName }),
              })),
            },
          }),
    });
    if (!response.ok) {
      return response;
    }
    const body = response.body;
    return {
      ok: true,
      body: {
        item: await this.addedItem(body.item_key, body.citation_key),
        existing: body.existing,
        method: body.method,
        finalUrl: body.details.final_url,
        attachmentFailures: body.details.attachment_failures,
      },
    };
  }

  private async addedItem(itemKey: string, citationKey: string): Promise<ZoteroAddedItem> {
    return {
      itemKey,
      citationKey,
      citable: await this.citeproc.awaitMainLibraryItem(citationKey, CITABLE_DEADLINE_MS),
    };
  }

  private async write<Body>(body: AddonWriteRequest): Promise<ZoteroResult<Body>> {
    return await this.request<Body>(new URL("/write", ZOTERO_ORIGIN), body);
  }

  /**
   * One request to Zotero. An add-on error keeps its status, except that a
   * Zotero-side failure (5xx) is a 502 of this API; the 422 of a source that
   * no method identifies carries the add-on's remediation.
   */
  private async request<Body>(url: URL, body: AddonWriteRequest | undefined): Promise<ZoteroResult<Body>> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      // fetch rejects with a TypeError when no server answers at the origin.
      if (!(error instanceof TypeError)) {
        throw error;
      }
      return {
        ok: false,
        status: 503,
        code: "ZOTERO_UNAVAILABLE",
        message: `Zotero does not answer at ${ZOTERO_ORIGIN}: ${String(error.cause ?? error.message)}`,
      };
    }
    const text = await response.text();
    if (response.ok) {
      return { ok: true, body: JSON.parse(text) as Body };
    }
    if (url.pathname !== "/write") {
      return { ok: false, status: 502, code: "ZOTERO_REQUEST_FAILED", message: `Zotero ${response.status}: ${text}` };
    }
    const error = JSON.parse(text) as AddonError;
    if (error.stage === "identify_source") {
      const remediation = error.details.remediation;
      if (remediation === undefined) {
        throw new Error("The Zotero add-on answered identify_source without a remediation; it is older than 3.4.0");
      }
      return {
        ok: false,
        status: 422,
        code: "ZOTERO_SOURCE_NOT_IDENTIFIED",
        message: error.error,
        remediation: {
          message: remediation.message,
          alternativeSources: remediation.alternative_sources,
        },
      };
    }
    return {
      ok: false,
      status: response.status >= 500 ? 502 : response.status,
      code: "ZOTERO_REQUEST_FAILED",
      message: `${error.stage}: ${error.error}`,
    };
  }
}
