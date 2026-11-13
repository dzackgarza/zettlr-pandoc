/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The Agent API contract as the specs read it
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The specs of the Agent API check each answer of the
 *                  server against openapi.yaml: a status that the document
 *                  does not declare for the operation of the request fails,
 *                  and a JSON body is validated against the schema of its
 *                  declared response (#57).
 *
 * END HEADER
 */

import type { AgentApiComponents } from "@dts/common/agent-api";
import Ajv2020 from "ajv/dist/2020";
import { strict as assert } from "assert";
import { readFileSync } from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";

/**
 * The specification as this file reads it. An operation keeps an index
 * signature so the structural audits below can walk any field generically,
 * and `requestBody` is spelled out because tests read published request
 * bounds out of it: a value reached through a declared path needs no cast to
 * be used, and a cast is what would let this shape drift from the document
 * without anything noticing.
 */
export interface PublishedNumericBounds {
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  default?: number;
}

export interface PublishedOperation {
  [field: string]: unknown;
  operationId: string;
  tags?: string[];
  requestBody?: {
    content: Record<string, { schema: { properties: Record<string, PublishedNumericBounds> } }>;
  };
  responses: Record<string, { content?: Record<string, { schema: object }> }>;
}

/**
 * Validates a response body against the schema the server itself publishes.
 * Field-by-field assertions cannot catch drift in a field nobody thought to
 * assert — `type` shipped as the internal enum ordinal (1) instead of the
 * declared "markdown" | "code" through a fully green suite. Every response
 * asserted here is checked against openapi.yaml as a whole.
 */
export const openApiDocument = parseYaml(
  readFileSync(
    path.join(__dirname, "../source/app/service-providers/agent-api/openapi.yaml"),
    "utf8",
  ),
) as {
  info: { version: string };
  components: { schemas: Record<string, unknown> };
  paths: Record<string, Record<string, PublishedOperation>>;
};

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

const ajv = new Ajv2020({ strict: false, allErrors: true });
for (const [name, schema] of Object.entries(openApiDocument.components.schemas)) {
  ajv.addSchema(schema as object, `#/components/schemas/${name}`);
}

export type AgentApiSchemas = AgentApiComponents["schemas"];

/** Parse a response body and prove that it conforms to the named OpenAPI schema. */
export function parseAs<N extends keyof AgentApiSchemas & string>(
  body: string,
  schemaName: N,
): AgentApiSchemas[N] {
  const value: JsonValue = JSON.parse(body);
  if (ajv.validate<AgentApiSchemas[N]>(`#/components/schemas/${schemaName}`, value)) {
    return value;
  }
  assert.fail(`Response does not conform to ${schemaName}: ${ajv.errorsText()}\n${body}`);
}

// The whole document is one schema too, so that a response schema of an
// operation is validated where the document declares it, with its references
// resolved against the same document.
ajv.addSchema(openApiDocument, "openapi");

/** A JSON Pointer token (RFC 6901). */
function pointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

/**
 * The operation of the document that a request names: the path template that
 * matches the path of the target, and the method. A route that no operation
 * declares (`/mcp`, `/openapi.json`, an unknown path) has none.
 */
function operationOf(
  method: string,
  target: string,
): { route: string; method: string; operation: PublishedOperation } | undefined {
  const pathname = target.split("?")[0];
  const lowerMethod = method.toLowerCase();
  for (const [route, methods] of Object.entries(openApiDocument.paths)) {
    const template = new RegExp(
      `^${route.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "[^/]+")}$`,
    );
    const operation = methods[lowerMethod];
    if (operation !== undefined && template.test(pathname)) {
      return { route, method: lowerMethod, operation };
    }
  }
  return undefined;
}

/**
 * Proves that an answer of the server is one that the document declares for
 * the operation of its request: its status is a declared response of that
 * operation, and a JSON body conforms to the schema that the response
 * declares. A status that the server sends and the document leaves out is an
 * answer that a client generated from the document cannot model (#57).
 */
export function assertDeclaredResponse(
  method: string,
  target: string,
  status: number,
  contentType: string | undefined,
  body: string,
): void {
  const matched = operationOf(method, target);
  if (matched === undefined) {
    return;
  }
  const { route, operation } = matched;
  const declared = operation.responses[String(status)];
  assert.ok(
    declared !== undefined,
    `${operation.operationId} answered ${status}, a status that the document does not declare for it: ${body}`,
  );
  const schema = declared.content?.["application/json"]?.schema;
  if (schema === undefined || contentType?.startsWith("application/json") !== true) {
    return;
  }
  const pointer = [
    "paths",
    route,
    matched.method,
    "responses",
    String(status),
    "content",
    "application/json",
    "schema",
  ]
    .map(pointerToken)
    .join("/");
  assert.ok(
    ajv.validate({ $ref: `openapi#/${pointer}` }, JSON.parse(body)),
    `${operation.operationId} ${status} does not conform to its declared schema: ${ajv.errorsText()}\n${body}`,
  );
}

/** Proves `assertDeclaredResponse` of a raw HTTP/1.1 answer as a socket received it. */
export function assertDeclaredRawResponse(method: string, target: string, raw: string): void {
  const head = raw.slice(0, raw.indexOf("\r\n\r\n"));
  const [statusLine, ...headerLines] = head.split("\r\n");
  const status = Number(statusLine.split(" ")[1]);
  const contentType = headerLines
    .find((line) => line.toLowerCase().startsWith("content-type:"))
    ?.slice("content-type:".length)
    .trim();
  assertDeclaredResponse(method, target, status, contentType, raw.slice(head.length + 4));
}
