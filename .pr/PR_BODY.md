# Claim

Implement Zettlr's embedded, unauthenticated OpenAPI API for a remote-first document review workflow.

# Delivery Boundary

- The server binds only to `127.0.0.1`; tunnel deployment is external infrastructure.

- The application has no bearer authentication, TLS listener, remote-bind mode, CORS policy, or Cloudflare-specific request handling.

- Remote clients use opaque document IDs to discover focused/open context, read live buffers and slices, search, submit unified-diff proposals, inspect reviews, and clear or retract unresolved work.

- Proposal, clear, retract, and renderer-decision transitions update the authoritative provider buffer, review generation, and review events.

- The API exposes SSE and long-poll review observation with canonical event fields.

- The OpenAPI specification is bundled with the application and served at `/openapi.yaml`.

# Evidence

- `bun ci` passes after the lockfile records the declared `@codemirror/merge` and `diff` dependencies.

- `just test-file test/agent-http-api.spec.ts` passes: 15 focused HTTP API tests.

- `just test-file test/agent-http-api-e2e-cross-process.spec.ts` passes: 4 separate-process loopback API tests.

## Policy alignment gate — required

<!-- policy-alignment-gate -->

- [x] The PR removes application authentication, transport fallbacks, and legacy discovery state rather than preserving compatibility paths.
- [x] The PR does not modify QC tooling.

# Completion Boundary

This branch is not yet certified for merge.
The remaining required proof is a real remote-client run through a named Cloudflare Tunnel hostname, from a process without access to the editor machine's filesystem or local sockets.
Localhost and cross-process harness results do not substitute for that boundary.
