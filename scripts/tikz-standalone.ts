import { realpath, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import {
  renderTikz,
  resolveTikzDataDir,
  resolveTikzTemplatePath,
} from "../packages/tikz-workbench/tikz-render";
import { projectQuiverMacros } from "../packages/tikz-workbench/quiver-macros";
import { parseMathJaxMacros } from "../packages/tikz-workbench/mathjax-config";

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
    if (url.pathname === "/api/quiver-macros" && request.method === "GET") {
      const macros = parseMathJaxMacros(JSON.parse(await readFile(path.join(home, ".pandoc/templates/css/mathjax-macros.json"), "utf8")));
      return Response.json(projectQuiverMacros(macros, config.templatePath));
    }
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    if (url.pathname === "/") return new Response(Bun.file(path.join(root, "packages/tikz-workbench/index.html")));
    if (url.pathname === "/host.js") return new Response(Bun.file(path.join(import.meta.dir, "tikz-standalone-host.js")));
    if (url.pathname.startsWith("/tikz-image/")) {
      const documentDir = path.dirname(documentPath);
      const relative = decodeURIComponent(url.pathname.slice("/tikz-image/".length));
      const asset = path.resolve(documentDir, relative);
      if (!asset.startsWith(`${documentDir}${path.sep}`)) return new Response("Not found", { status: 404 });
      if (!new Set([".png", ".jpg", ".jpeg", ".svg"]).has(path.extname(asset).toLowerCase())) {
        return new Response("Unsupported image format", { status: 415 });
      }
      let actual: string;
      try {
        actual = await realpath(asset);
      } catch {
        return new Response("Not found", { status: 404 });
      }
      if (!actual.startsWith(`${documentDir}${path.sep}`)) return new Response("Not found", { status: 404 });
      const file = Bun.file(actual);
      return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
    }
    if (url.pathname.startsWith("/quiver/")) {
      const quiverRoot = path.join(root, "vendor/quiver/src");
      const asset = path.resolve(quiverRoot, `.${url.pathname.slice("/quiver".length)}`);
      if (!asset.startsWith(`${quiverRoot}${path.sep}`)) return new Response("Not found", { status: 404 });
      const file = Bun.file(asset);
      return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
    }
    if (!url.pathname.startsWith("/tikz-editor/")) return new Response("Not found", { status: 404 });
    const asset = path.resolve(assetRoot, `.${url.pathname.slice("/tikz-editor".length)}`);
    if (!asset.startsWith(`${assetRoot}${path.sep}`)) return new Response("Not found", { status: 404 });
    const file = Bun.file(asset);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(file);
  },
});

console.log(`TikZ editor: http://127.0.0.1:${server.port}/`);
