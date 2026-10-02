/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        AgentMcpEndpoint
 * CVM-Role:        Controller
 * Maintainer:      D. Zack Garza
 * License:          GNU GPL v3
 *
 * Description:     The agent API as a Model Context Protocol server, served
 *                  at /mcp over stateless streamable HTTP. ChatGPT apps and
 *                  other MCP clients connect to MCP servers only; they cannot
 *                  import an OpenAPI document.
 *
 *                  Each OpenAPI operation is one MCP tool. A tool call is an
 *                  HTTP request to this same server, so routing, validation
 *                  and every handler stay in the OpenAPI pipeline. This is
 *                  the design of FastMCP's `FastMCP.from_openapi`
 *                  (https://gofastmcp.com/integrations/openapi).
 *
 * END HEADER
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type http from "http";
import type { Operation } from "openapi-backend";

/** The arguments of one tool call, as the MCP SDK types them. */
type ToolArguments = NonNullable<CallToolRequest["params"]["arguments"]>;
type ToolArgument = ToolArguments[string];
type PropertySchema = NonNullable<Tool["inputSchema"]["properties"]>[string];

/** The tool argument that carries an operation's JSON request body. */
const BODY_ARGUMENT = "body";

interface OperationTool {
  tool: Tool;
  method: string;
  path: string;
  pathParameters: string[];
  queryParameters: string[];
}

/**
 * One tool per operation. The input schema is the operation's path and query
 * parameters plus its JSON request body under `body`, all taken from the
 * dereferenced OpenAPI document.
 */
function operationTool(operation: Operation): OperationTool {
  const operationId = operation.operationId;
  if (operationId === undefined) {
    throw new Error(`OpenAPI operation ${operation.method} ${operation.path} has no operationId`);
  }
  const properties: Record<string, PropertySchema> = {};
  const required: string[] = [];
  const pathParameters: string[] = [];
  const queryParameters: string[] = [];
  // OpenAPI omits `parameters` from an operation that takes none.
  const parameters = operation.parameters;
  if (parameters !== undefined) {
    for (const parameter of parameters) {
      if ("$ref" in parameter) {
        throw new Error(`Operation ${operationId} has an unresolved parameter ${parameter.$ref}`);
      }
      if (parameter.in === "path") {
        pathParameters.push(parameter.name);
      } else if (parameter.in === "query") {
        queryParameters.push(parameter.name);
      } else {
        throw new Error(
          `Operation ${operationId} has a ${parameter.in} parameter; MCP tools carry none`,
        );
      }
      properties[parameter.name] = {
        ...parameter.schema,
        ...(parameter.description === undefined ? {} : { description: parameter.description }),
      };
      if (parameter.required === true) {
        required.push(parameter.name);
      }
    }
  }
  const requestBody = operation.requestBody;
  if (requestBody !== undefined) {
    if ("$ref" in requestBody) {
      throw new Error(
        `Operation ${operationId} has an unresolved request body ${requestBody.$ref}`,
      );
    }
    const schema = requestBody.content["application/json"]?.schema;
    if (schema === undefined) {
      throw new Error(`Operation ${operationId} has a request body that is not application/json`);
    }
    properties[BODY_ARGUMENT] = schema;
    if (requestBody.required === true) {
      required.push(BODY_ARGUMENT);
    }
  }
  const description = [operation.summary, operation.description]
    .filter((text): text is string => text !== undefined && text.length > 0)
    .join("\n\n");
  const readOnly = operation.method === "get";
  return {
    tool: {
      name: operationId,
      description,
      inputSchema: { type: "object", properties, required },
      annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false },
    },
    method: operation.method.toUpperCase(),
    path: operation.path,
    pathParameters,
    queryParameters,
  };
}

function queryValues(name: string, value: ToolArgument): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item: ToolArgument) => queryValues(name, item));
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  throw new Error(`Query parameter ${name} must be a string, number, boolean or array of those`);
}

export default class AgentMcpEndpoint {
  private readonly _tools: Map<string, OperationTool>;

  constructor(
    operations: Operation[],
    private readonly _serverInfo: { name: string; version: string },
  ) {
    this._tools = new Map(
      operations.map((operation) => {
        const entry = operationTool(operation);
        return [entry.tool.name, entry];
      }),
    );
  }

  /**
   * Answers one MCP exchange. The transport is stateless, so every request
   * gets its own server and transport, as in the SDK's stateless example.
   * `apiOrigin` is this listener's own loopback origin; tool calls go there.
   */
  async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsedBody: ToolArgument,
    apiOrigin: string,
  ): Promise<void> {
    // The tools are OpenAPI JSON Schemas, not Zod schemas, so they are
    // registered on the protocol-level server under McpServer.
    const server = new McpServer(this._serverInfo, { capabilities: { tools: {} } });
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [...this._tools.values()].map((entry) => entry.tool),
    }));
    server.server.setRequestHandler(CallToolRequestSchema, (request) =>
      this.callTool(request.params.name, request.params.arguments, apiOrigin),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  }

  private async callTool(
    name: string,
    // MCP omits `arguments` from a call that passes none.
    args: ToolArguments | undefined,
    apiOrigin: string,
  ): Promise<CallToolResult> {
    const entry = this._tools.get(name);
    if (entry === undefined) {
      return { isError: true, content: [{ type: "text", text: `Unknown tool ${name}` }] };
    }
    let route = entry.path;
    for (const parameter of entry.pathParameters) {
      const value = args?.[parameter];
      if (typeof value !== "string" && typeof value !== "number") {
        return {
          isError: true,
          content: [{ type: "text", text: `Path parameter ${parameter} is required` }],
        };
      }
      route = route.replace(`{${parameter}}`, encodeURIComponent(String(value)));
    }
    const url = new URL(route, apiOrigin);
    for (const parameter of entry.queryParameters) {
      const value = args?.[parameter];
      if (value === undefined) {
        continue;
      }
      for (const item of queryValues(parameter, value)) {
        url.searchParams.append(parameter, item);
      }
    }
    const body = args?.[BODY_ARGUMENT];
    const response = await fetch(url, {
      method: entry.method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      isError: !response.ok,
      content: [{ type: "text", text: text.length > 0 ? text : `HTTP ${response.status}` }],
    };
  }
}
