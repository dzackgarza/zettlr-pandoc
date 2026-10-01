/**
 * The standalone host for one .tikz or .tikzcd file. It builds the workbench
 * page with Vite, then serves the page, the pinned editor pages, the file, the
 * TeX compiler and the Quiver macro projection on 127.0.0.1.
 *
 * Usage: bun run standalone/server.ts <file.tikz>
 */

import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import { parseMathJaxMacros } from "../src/mathjax-config";
import { projectQuiverMacros } from "../src/quiver-macros";
import {
  renderTikz,
  resolveTikzDataDir,
  resolveTikzTemplatePath,
  type TikzRenderRequest,
} from "../src/tikz-render";

const input = Bun.argv[2];
if (input === undefined || ![".tikz", ".tikzcd"].includes(path.extname(input))) {
  throw new Error("Usage: bun run standalone/server.ts <file.tikz|file.tikzcd>");
}

const documentPath = await realpath(input);
const documentDir = path.dirname(documentPath);
const packageRoot = path.resolve(import.meta.dir, "..");
const pageRoot = path.join(import.meta.dir, "dist");
const home = os.homedir();
const config = {
  tikzAssetDir: resolveTikzDataDir("", home),
  templatePath: resolveTikzTemplatePath(home),
  cacheDir: path.join(home, ".cache", "tikz-workbench"),
  env: process.env,
};
const macroProjectionPath = path.join(home, ".pandoc", "templates", "css", "mathjax-macros.json");
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".svg"]);

await build({ configFile: path.join(packageRoot, "vite.config.ts"), logLevel: "warn" });

function revisionOf(source: string): string {
  return `"${createHash("sha256").update(source).digest("hex")}"`;
}

/** Serve `relative` from `root`; a path that resolves outside `root` is not found. */
async function serveUnder(root: string, relative: string): Promise<Response> {
  const requested = path.resolve(root, `.${relative}`);
  if (!requested.startsWith(`${root}${path.sep}`)) return new Response("Not found", { status: 404 });
  let actual: string;
  try {
    actual = await realpath(requested);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (!actual.startsWith(`${root}${path.sep}`)) return new Response("Not found", { status: 404 });
  return new Response(Bun.file(actual));
}

async function handleDocument(request: Request): Promise<Response> {
  const current = await readFile(documentPath, "utf8");
  if (request.method === "GET") {
    return new Response(current, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        etag: revisionOf(current),
        "x-document-path": documentPath,
      },
    });
  }
  if (request.method !== "PUT") return new Response("Method not allowed", { status: 405 });
  const expected = request.headers.get("if-match");
  if (expected === null) return new Response("File revision required", { status: 428 });
  if (expected !== revisionOf(current)) return new Response("The file changed on disk", { status: 412 });
  const next = await request.text();
  await writeFile(documentPath, next, "utf8");
  return new Response(null, { status: 204, headers: { etag: revisionOf(next) } });
}

async function handleRender(request: Request): Promise<Response> {
  const body = (await request.json()) as TikzRenderRequest;
  // The page edits exactly one file: \input and image paths resolve against it.
  return Response.json(await renderTikz({ ...body, docPath: documentPath }, config));
}

async function handleQuiverMacros(): Promise<Response> {
  const macros = parseMathJaxMacros(JSON.parse(await readFile(macroProjectionPath, "utf8")));
  return Response.json(projectQuiverMacros(macros, config.templatePath));
}

async function handleImage(relative: string): Promise<Response> {
  if (!IMAGE_EXTENSIONS.has(path.extname(relative).toLowerCase())) {
    return new Response("Unsupported image format", { status: 415 });
  }
  return await serveUnder(documentDir, relative);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  // Bun's documented 10-second default is shorter than renderTikz's 30-second TeX limit.
  // https://bun.com/docs/runtime/http/server#idleTimeout
  idleTimeout: 40,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/document") return await handleDocument(request);
    if (pathname === "/api/render" && request.method === "POST") return await handleRender(request);
    if (pathname === "/api/quiver-macros" && request.method === "GET") return await handleQuiverMacros();
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    if (pathname.startsWith("/tikz-image/")) {
      return await handleImage(`/${decodeURIComponent(pathname.slice("/tikz-image/".length))}`);
    }
    if (pathname.startsWith("/tikz-editor/")) {
      return await serveUnder(path.join(packageRoot, "vendor", "tikz-editor", "src"), pathname.slice("/tikz-editor".length));
    }
    if (pathname.startsWith("/quiver/")) {
      return await serveUnder(path.join(packageRoot, "vendor", "quiver", "src"), pathname.slice("/quiver".length));
    }
    return await serveUnder(pageRoot, pathname === "/" ? "/index.html" : pathname);
  },
});

console.log(`TikZ workbench: http://127.0.0.1:${server.port}/`);
