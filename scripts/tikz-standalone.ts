import { realpath, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import {
  renderTikz,
  resolveTikzDataDir,
  resolveTikzTemplatePath,
} from "../source/app/util/tikz-render";

const input = Bun.argv[2];
if (input === undefined || path.extname(input) !== ".tikz") {
  throw new Error("Usage: just tikz-standalone <file.tikz>");
}

const documentPath = await realpath(input);
const root = path.resolve(import.meta.dir, "..");
const assetRoot = path.join(root, "vendor/tikz-editor/src");
const home = os.homedir();
const config = {
  tikzAssetDir: resolveTikzDataDir("", home),
  templatePath: resolveTikzTemplatePath(home),
  cacheDir: path.join(home, ".cache/tikz-standalone"),
  env: process.env,
};

function revisionOf(source: string): string {
  return `"${createHash("sha256").update(source).digest("hex")}"`;
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  // Bun's documented 10-second default is shorter than renderTikz's 30-second TeX limit.
  // https://bun.com/docs/runtime/http/server#idleTimeout
  idleTimeout: 40,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/document") {
      if (request.method === "GET") {
        const source = await readFile(documentPath, "utf8");
        return new Response(source, {
          headers: { "content-type": "text/plain; charset=utf-8", etag: revisionOf(source) },
        });
      }
      if (request.method === "PUT") {
        const current = await readFile(documentPath, "utf8");
        const expected = request.headers.get("if-match");
        if (expected === null) return new Response("File revision required", { status: 428 });
        if (expected !== revisionOf(current)) return new Response("File changed on disk", { status: 412 });
        const next = await request.text();
        await writeFile(documentPath, next, "utf8");
        return new Response(null, { status: 204, headers: { etag: revisionOf(next) } });
      }
    }
    if (url.pathname === "/api/render" && request.method === "POST") {
      const result = await renderTikz(
        { source: await request.text(), kind: "raw", language: "tikz", docPath: documentPath },
        config,
      );
      return Response.json(result);
    }
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    if (url.pathname === "/") return new Response(Bun.file(path.join(import.meta.dir, "tikz-standalone.html")));
    if (!url.pathname.startsWith("/tikz-editor/")) return new Response("Not found", { status: 404 });
    const asset = path.resolve(assetRoot, `.${url.pathname.slice("/tikz-editor".length)}`);
    if (!asset.startsWith(`${assetRoot}${path.sep}`)) return new Response("Not found", { status: 404 });
    const file = Bun.file(asset);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(file);
  },
});

console.log(`TikZ editor: http://127.0.0.1:${server.port}/`);
