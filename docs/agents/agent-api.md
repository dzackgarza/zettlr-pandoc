# 6. Agent API MCP tunnel

- The agent API listens on `127.0.0.1:27412` only. It serves the OpenAPI
  routes and, at `/mcp`, the same operations as an MCP server
  (`source/app/service-providers/agent-api/mcp-endpoint.ts`).
- **A client finds its instance through the discovery file.** When the
  listener is bound, the app writes `agent-api.port` into `userData`: the
  bound port and the id of the instance that `/v1/ping` answers
  (`agent-api/discovery-file.ts`). A killed instance leaves its file, and
  another instance can bind its port, so a client takes the listener on that
  port only when its ping names the same id (`readAgentApiPort` in
  `e2e/support/electron-app.ts`). Proof: `test/agent-http-api.spec.ts`
  ("a stale discovery file").
- **A change that an older client cannot use raises the major version.**
  `info.version` of `openapi.yaml` is the protocol version that `/v1/ping`
  answers, and `zettlr-pandoc-review-diff` refuses each other version
  (`PROTOCOL_VERSION_UNSUPPORTED`) before it sends a request that changes
  state. A new required field of a request, a removed operation or a removed
  field of an answer raises the major version; another change of the
  contract (a new error code, a new operation) raises the minor version. The
  CLI accepts one version, so its constant follows each change. Version 2.0.0
  made `clientRequestId` of a proposal required; version 2.1.0 added
  `PROPOSAL_NOT_FOUND`; version 3.0.0 removed `active` of a view of
  `/v1/views`, which was a copy of `focused` (`documentId` names the
  active tab).
  `bun run check:agent-api-types` proves that the generated types are those
  of the document; the hosted `check.yml` runs it.
- **Each status on the wire is one that the document declares.** A handler
  answers through `Reply<Op>` (`http-server.ts`): `sendJson` and `sendError`
  take only a status that `openapi.yaml` declares for the operation, and
  `STATUS_BY_CODE` gives the status of each error code. A refusal whose
  status the operation does not declare goes through `sendRefusal`, which
  logs the gap and answers 500. A route answers only the errors that it
  classifies; each other error reaches the dispatcher, which answers a
  document that cannot be read with 409 `DOCUMENT_UNREADABLE` and logs the
  rest with its stack. Proof: `test/agent-http-api.spec.ts` (each answer is
  checked against the declared response; each `$ref` of the served
  documents resolves).
- **Each request carries the token.** A caller sends
  `Authorization: Bearer <token>`, where the token is the value of
  `ZETTLR_AGENT_API_TOKEN` in the environment of the app. `dispatch`
  (`http-server.ts`) verifies it before it reads the body or selects a
  handler, and answers 401 `UNAUTHORIZED` without it. A loopback caller has no
  exemption: each tunnel to the listener arrives from loopback. Only
  `GET /openapi.yaml` and `GET /openapi.json` answer without the token, so an
  importer can read the contract; the document declares the scheme
  (`bearerToken`), which makes the import of a Custom GPT Action ask for the
  key. An MCP tool call is a request of the same caller to the same listener
  and carries the same header.
- **The token has one home, `~/.envrc`.** No configuration key and no file of
  the app holds it. An app with an enabled API and no token in its
  environment does not start (`AgentApiTokenRequiredError`, a native error
  dialog); `agentApi.enabled: false` starts it without the API. Each owner of
  a process gives the variable: `zettlr-pandoc-boot` starts the app under
  `direnv exec "$HOME"`, the tunnel unit sends the header through
  `MCP_EXTRA_HEADERS`, `zettlr-pandoc-review-diff` reads the variable and
  stops without it, and a development start (`just launch`,
  `just launch-desktop`) takes it from the shell. An e2e run makes a token of
  its own (`AGENT_API_TOKEN` in `e2e/support/electron-app.ts`).
- **The review CLI sends the baseline of the producer of the patch.**
  `baselineSha256` of a proposal pins the text that the patch was made from.
  `zettlr-pandoc-review-diff` requires `--baseline-sha256` and refuses a
  call without it before the first request; it sends no hash of a read of
  its own, and it holds no copy of the comparison: the editor refuses a
  baseline that is not its working text (`REVISION_MISMATCH`). A new field
  that a request requires is an option that the CLI requires, not a value
  that the CLI fills in. Proof: `test/agent-http-api.spec.ts` ("sends
  nothing from the external CLI when no baseline of the patch is given").
- Operations tagged `zotero` in `openapi.yaml` are served at `/zotero/mcp` (MCP
  server `zettlr-pandoc-zotero`), not at `/mcp`, and the served `/openapi.json`
  leaves out their routes; the Custom GPT Action imports that document and has
  a limit of 30 operations. `ZoteroLibrary` (`agent-api/zotero-library.ts`)
  searches through the Zotero local API (`/api`) and imports through the
  `/write` route of the zotero-local-write-api add-on. The setting
  `zotero.localServer` (`http://127.0.0.1:23119`, the port of the Zotero
  preference `extensions.zotero.httpServer.port`) is the origin of these
  routes and of the Better BibTeX JSON-RPC of the open-attachment command. Zotero
  identifies the source and fetches the metadata and the PDF; the caller sends
  no BibTeX. A source that Zotero cannot identify answers 422
  `ZOTERO_SOURCE_NOT_IDENTIFIED` with the add-on's remediation (known-good
  sources). A repeat with `fallbackMetadata` (title, creators, year) saves the
  item tagged `metadata:unresolved`. An import returns the Better BibTeX key and
  waits until the main citation library (the Better BibTeX auto-export) has it
  (`citable`). `just test-zotero-integration` proves this against the running
  Zotero. An operation that needs the add-on answers 503 `ZOTERO_UNAVAILABLE`
  when Zotero does not answer and when Zotero answers without the add-on: its
  own text/plain 404 for `/write` (`test/zotero-without-write-addon.spec.ts`).
- ChatGPT reaches `/mcp` only through the OpenAI Secure MCP Tunnel
  `tunnel_6aba3fe9f56081919348c7060b52188f`. The user unit
  `scripts/systemd/openai-tunnel-zettlr-pandoc.service` runs
  [`tunnel-client`](https://github.com/openai/tunnel-client) from
  `~/.local/bin`. It long-polls `api.openai.com` with `CONTROL_PLANE_API_KEY` from
  `~/.envrc`, so it needs no inbound port and no public hostname. The unit
  gives tunnel-client the header `Authorization: Bearer <token>` in
  `MCP_EXTRA_HEADERS`, made by a shell from the environment so that the token
  is in no argument list; tunnel-client sends it with each request to `/mcp`.
  A header that the ChatGPT app forwards replaces a static header of the same
  name, so the app in ChatGPT has no authentication of its own. The unit sets
  `GODEBUG=http2client=0`: over HTTP/2 the client keeps one dead connection
  after a suspend and misses every request for about 16 minutes. The system
  unit `openai-tunnel-zettlr-pandoc-resume@.service` also restarts the tunnel
  at each resume (`just install-systemd-tunnel-resume`).
- Recipes: `just install-systemd-tunnel`, `just start-systemd-tunnel`,
  `just status-systemd-tunnel`. The tunnel-client health and web UI listener is
  `http://127.0.0.1:27414/ui`; `/readyz` reports readiness.
- In ChatGPT, the app uses Connection: Tunnel with that tunnel ID. Tool calls fail
  while the editor is closed; the tunnel itself stays up.
- The Cloudflare tunnel is a second route of the user. The user unit
  `cloudflared-zettlr.service` (owned by the dotfiles of the user, with the
  configuration `~/.cloudflared/zettlr-pandoc-laptop.yml`) publishes the
  listener at a public hostname. It is a part of the working system, as the
  OpenAI tunnel is. A request through it carries the token as each other
  request does, and the route answers only while the editor is open.
- ChatGPT keeps the tool list it read when the app was created or last
  refreshed. A contract change (a new operation, a new request body) reaches
  ChatGPT only after Refresh on the app's settings page and a new
  conversation. Until then the model calls the old tool shapes.
- `agentApi.skillsDirectory` in `config.json` is a read-only filesystem
  capability exposed through the existing `getHelp` MCP tool: use
  `resource=skills`, with `action=list` or `action=read` plus a relative `.md`
  `path`. Symlinks, traversal, and non-Markdown files are not exposed. A
  folder that the filesystem refuses is in the `notListed` of the listing,
  and a refused read of a skill or a figure answers 409 `FILE_UNREADABLE`. The
  ChatGPT connector has a hard 30-tool limit; `/mcp` itself must therefore stay
  at 30 tools rather than hiding extra operations only from `/openapi.json`.
