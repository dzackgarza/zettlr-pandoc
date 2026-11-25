# 29. HTTP requests

- **`got` 16 makes each HTTP request of the main process** (the update
  check and its downloads, the link preview). It is an ES module whose
  package has an `exports` map only. The type checker therefore resolves a
  package as webpack does (`tsconfig.json`: `module: preserve`,
  `moduleResolution: bundler`), and ts-loader states the CommonJS emit of
  the bundles itself (`webpack.rules.js`).
- **The Node of Electron is not the Node of the unit tests.** Under the
  Node of Electron a TLS socket ends a destroyed request with an error of
  its own, which `got` 11 gave to the caller in place of the timeout. A spec
  whose subject depends on that Node starts the Electron binary with
  `ELECTRON_RUN_AS_NODE` (`test/updater-check-timeout.spec.ts`).
- **The time limit of a request is `timeout.request`.**
- **The headers of a response come from the stream of the request.** The
  promise of a request gives its `response` event after the body.
  `fetchHeaders` (`common/util/fetch-link-preview.ts`) reads the headers
  from `got.stream` and destroys the stream, so a linked file of another
  content type is not downloaded.
- **Proof:** `test/updater-check-timeout.spec.ts`,
  `test/fetch-link-preview.spec.ts`.
