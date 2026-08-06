/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Agent API wire types
 * CVM-Role:         Types
 * Maintainer:       D. Zack Garza
 * License:          GNU GPL v3
 *
 * Description:     Thin aliases over the types generated from
 *                  service-providers/agent-api/openapi.yaml. The OpenAPI
 *                  document is the contract; nothing here redeclares a
 *                  request or response field. Regenerate with
 *                  `bun run generate:agent-api-types`.
 *
 *                  Mutable internal review state lives in ./review-domain,
 *                  not here: a wire response is a value the server hands out,
 *                  never a record the application edits in place.
 *
 * END HEADER
 */

import type { components, operations, paths } from "../generated/agent-api";

type Schemas = components["schemas"];

export type DocumentRevision = Schemas["DocumentRevision"];
export type EditorViewSummary = Schemas["EditorViewSummary"];
export type ReviewState = Schemas["ReviewState"];
export type ReviewSummary = Schemas["ReviewSummary"];
export type ReviewComment = Schemas["ReviewComment"];
export type DocumentSummary = Schemas["DocumentSummary"];
export type EditorContext = Schemas["EditorContext"];
export type ReadDocumentResponse = Schemas["ReadDocumentResponse"];
export type SearchDocumentRequest =
  operations["searchDocument"]["requestBody"]["content"]["application/json"];
export type SearchDocumentResponse = Schemas["SearchDocumentResponse"];
export type SearchHit = SearchDocumentResponse["hits"][number];
export type ProposalClaim = Schemas["ProposalClaim"];

/**
 * `baselineSha256` and `clientRequestId` live in the body rather than in the
 * `If-Match` and `Idempotency-Key` headers this once required. A schema-driven
 * client cannot send those — an OpenAPI consumer generating calls from this
 * document (a Custom GPT Action, for one) drops header parameters and would be
 * refused on every attempt.
 */
export type SubmitProposalRequest = Schemas["SubmitProposalRequest"];
export type SubmitProposalResponse = Schemas["SubmitProposalResponse"];
export type ProposalPacket = Schemas["ProposalPacket"];
export type OutstandingChunk = Schemas["OutstandingChunk"];
export type ReviewDiffResponse = Schemas["ReviewDiffResponse"];
export type ReviewChunksResponse = Schemas["ReviewChunksResponse"];
export type ReviewPacketsResponse = Schemas["ReviewPacketsResponse"];
export type ReviewDetailResponse = Schemas["ReviewDetailResponse"];
export type ReviewListEntry = Schemas["ReviewListEntry"];
export type ReviewListResponse = Schemas["ReviewListResponse"];
export type ReviewMutationPrecondition = Schemas["ReviewMutationPrecondition"];
export type AddReviewCommentRequest = Schemas["AddReviewCommentRequest"];
export type ReviewCommentResponse = Schemas["ReviewCommentResponse"];
export type RetractProposalResponse = Schemas["RetractProposalResponse"];
export type FocusDocumentResponse = Schemas["FocusDocumentResponse"];
export type DocumentListResponse = Schemas["DocumentListResponse"];
export type ViewSummary = Schemas["ViewSummary"];
export type ViewsResponse = Schemas["ViewsResponse"];
export type WorkspacesResponse = Schemas["WorkspacesResponse"];
export type WorkspaceDocumentEntry = Schemas["WorkspaceDocumentSummary"];
export type WorkspaceDocumentsResponse = Schemas["WorkspaceDocumentsResponse"];
export type WorkspaceFileEntry = Schemas["WorkspaceFileEntry"];
export type WorkspaceFilesResponse = Schemas["WorkspaceFilesResponse"];
export type PingResponse = Schemas["PingResponse"];
export type CapabilitiesResponse = Schemas["CapabilitiesResponse"];
export type AgentEvent = Schemas["AgentEvent"];
export type AgentEventType = AgentEvent["event"];
export type ReviewEventsResponse = Schemas["ReviewEventsResponse"];
export type AgentError = Schemas["AgentError"];
export type AgentErrorCode = AgentError["code"];
export type AgentErrorResponse = Schemas["AgentErrorResponse"];

/** The `side` query parameter of the content read, with its declared default applied. */
export type ReadSide = NonNullable<
  NonNullable<operations["readDocumentContent"]["parameters"]["query"]>["side"]
>;

type JsonBody<Response> = Response extends {
  content: { "application/json": infer Body };
}
  ? Body
  : never;

/**
 * Every body the HTTP server may serialize, read off the operations the
 * document declares. Typing the send sink against this union is what makes an
 * undeclared response shape a compile error rather than a surprise for a
 * client written from the OpenAPI contract.
 */
export type AgentApiResponseBody = operations[keyof operations] extends infer Operation
  ? Operation extends { responses: infer Responses }
    ? { [Status in keyof Responses]: JsonBody<Responses[Status]> }[keyof Responses]
    : never
  : never;

export type {
  components as AgentApiComponents,
  operations as AgentApiOperations,
  paths as AgentApiPaths,
};
