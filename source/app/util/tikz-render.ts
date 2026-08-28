/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikZ render service
 * CVM-Role:        Utility Function
 * License:         GNU GPL v3
 *
 * Description:     Renders a TikZ figure (raw \begin{tikzcd}/\begin{tikzpicture}
 *                  block or a ```tikz code fence) to inline SVG by running the
 *                  vendored tikzcd.lua filter through pandoc against the
 *                  app-owned asset tree. The filter compiles via pdflatex and
 *                  pdf2svg with a content-addressed cache, namespaces SVG ids,
 *                  and emits one machine-parseable marker line per
 *                  figure-compile error; this module owns the process
 *                  plumbing and translates every outcome into a typed result —
 *                  missing tools, a toolchain probe that failed for a reason
 *                  other than absence, compile failures and a render killed by
 *                  a signal are loud and distinct, never silence. The
 *                  environment every child runs under is supplied by the
 *                  caller, never read from ambient process state.
 *
 * END HEADER
 */

import { spawn } from "child_process";
import { createHash } from "crypto";
import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

const REQUIRED_TIKZ_DATA_FILES = [
  "filters/tikzcd.lua",
  "filters/utilities.lua",
  "templates/standalone-tikz.tex",
] as const;

function hasTikzDataFiles(dataDir: string): boolean {
  return REQUIRED_TIKZ_DATA_FILES.every((relativePath) =>
    existsSync(path.join(dataDir, relativePath)),
  );
}

/**
 * Resolves the single Pandoc data tree used by editor TikZ rendering.
 *
 * An explicit setting is authoritative and must be complete. Without one, a
 * maintained user checkout at ~/.pandoc wins; users without that checkout use
 * the small app-owned fallback shipped beside the bundle.
 */
export function resolveTikzDataDir(
  configuredDir: string,
  homeDir: string,
  bundledDir: string,
): string {
  if (configuredDir !== "") {
    if (!hasTikzDataFiles(configuredDir)) {
      throw new Error(
        `Configured TikZ data directory ${configuredDir} must contain ` +
          REQUIRED_TIKZ_DATA_FILES.join(" and "),
      );
    }
    return configuredDir;
  }

  const userPandocDir = path.join(homeDir, ".pandoc");
  if (hasTikzDataFiles(userPandocDir)) {
    return userPandocDir;
  }

  if (!hasTikzDataFiles(bundledDir)) {
    throw new Error(
      `Bundled TikZ data directory ${bundledDir} must contain ` +
        REQUIRED_TIKZ_DATA_FILES.join(" and "),
    );
  }
  return bundledDir;
}

export interface TikzRenderRequest {
  /**
   * The figure source. For 'raw' this is the complete
   * \begin{tikzcd}/\begin{tikzpicture} … \end{…} block; for 'fence' it is the
   * body of a ```tikz code fence (a complete standalone document).
   */
  source: string;
  kind: "raw" | "fence";
  /**
   * The document the figure was authored in; the filter resolves the figure's
   * \input{…} against this file's directory.
   *
   * There is exactly one representation of "this buffer has no on-disk path":
   * the empty string. That is what the editor configuration stores in
   * `metadata.path` for an unsaved buffer (see getDefaultConfig), and it is
   * what the vendored filter branches on (`doc_path ~= ""` selects the
   * document root, otherwise the process working directory). The field is
   * therefore always supplied — a caller with no path passes the
   * configuration's own value, it does not omit the field.
   */
  docPath: string;
}

export interface TikzRenderConfig {
  /** The resolved user-owned or app-owned Pandoc data tree. */
  tikzAssetDir: string;
  /** The app-owned render cache; SVGs land and persist here. */
  cacheDir: string;
  /**
   * The environment every child process of this render runs under. It decides
   * which pandoc, pdflatex and pdf2svg are found, so it is an input to the
   * render, not an ambient condition the service may read for itself: the
   * caller states which environment it is asking for and that decision is
   * recorded at the call site.
   */
  env: NodeJS.ProcessEnv;
}

export interface TikzCompileError {
  /** 1-based line within the figure body. */
  line: number;
  /** The LaTeX bang-error message. */
  message: string;
  /** The verbatim figure-body source line the error maps to. */
  sourceLine: string;
}

export type TikzRenderResult =
  | { ok: true; html: string; svgPath: string }
  | { ok: false; kind: "missing-tools"; missing: string[] }
  /**
   * The toolchain probe itself failed. A tool that is not installed makes
   * spawn fail with ENOENT and is reported as 'missing-tools'; every other
   * spawn failure — EACCES for a file that is present but not executable,
   * EPERM, EAGAIN under resource exhaustion — means the tool's presence was
   * never established. Telling that user to install a tool they already have
   * is a wrong diagnosis, so the errno that ended the probe is carried and
   * the toolchain status stays unknown.
   */
  | { ok: false; kind: "toolchain-probe-failed"; tool: string; code: string }
  | { ok: false; kind: "compile-error"; errors: TikzCompileError[]; log: string }
  | { ok: false; kind: "pandoc-error"; log: string }
  /**
   * The render process was killed before it could finish (OOM killer, a
   * timeout kill, an interrupt). This is not pandoc reporting a problem: no
   * diagnostic was produced and nothing about the figure is known. The signal
   * that ended it is the information that distinguishes this outcome.
   */
  | { ok: false; kind: "render-terminated"; signal: NodeJS.Signals; log: string };

/**
 * How the pandoc child process ended. Node's 'close' event carries exactly one
 * of (code, signal): a process either exits with a status or is terminated by
 * a signal. Both are real outcomes, so both are carried as their own case.
 */
type PandocProcessOutcome =
  | { ended: "exit"; code: number; stdout: string; stderr: string }
  | { ended: "signal"; signal: NodeJS.Signals; stdout: string; stderr: string };

/** The tools the filter shells out to, checked before any render. */
const REQUIRED_TOOLS = ["pandoc", "pdflatex", "pdf2svg"];

/** One marker line per figure-compile error: body-line|message|source. */
const ERROR_MARKER_RE = /^\[tikzcd-figure-error\] (\d+)\|([^|]*)\|(.*)$/;

/**
 * What probing one executable established. 'absent' is the single errno that
 * means the tool is not installed; any other spawn failure establishes
 * nothing about the tool and is its own outcome.
 */
type ToolProbe =
  | { status: "available" }
  | { status: "absent" }
  | { status: "probe-failed"; code: string };

/**
 * Probes whether an executable is reachable in the given environment's PATH.
 * spawn's ENOENT is what "not installed" means; EACCES, EPERM, EAGAIN and the
 * rest are different facts and are reported as such rather than collapsed into
 * absence.
 */
async function probeTool(tool: string, env: NodeJS.ProcessEnv): Promise<ToolProbe> {
  return await new Promise<ToolProbe>((resolve, reject) => {
    const probe = spawn(tool, ["--version"], { env, stdio: "ignore" });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === undefined) {
        reject(
          new Error(
            `tikz-render: probing ${tool} emitted a child-process error carrying no errno code ` +
              `(message=${error.message}). Node reports a failure to spawn as a SystemError whose code ` +
              'names the cause; the probe classifies ENOENT as "not installed" and every other code as a ' +
              "failed probe, and cannot classify an error with no code at all.",
          ),
        );
        return;
      }
      resolve(
        error.code === "ENOENT"
          ? { status: "absent" }
          : { status: "probe-failed", code: error.code },
      );
    });
    probe.once("spawn", () => {
      // --version variants that wait on stdin must not hang the probe.
      probe.kill();
      resolve({ status: "available" });
    });
  });
}

/**
 * States Node's documented child-process contract: on 'close' exactly one of
 * (code, signal) is non-null. The signal case is dispatched before this call,
 * so reaching it with a null code means the runtime broke that contract and
 * the outcome below cannot be formed at all.
 */
function assertExitedWithCode(
  code: number | null,
  signal: NodeJS.Signals | null,
): asserts code is number {
  if (code === null) {
    throw new Error(
      "tikz-render: the pandoc child process closed carrying neither an exit code nor a signal " +
        `(code=${String(code)}, signal=${String(signal)}). Node's child_process 'close' event ` +
        "guarantees exactly one of the two is non-null; the outcome handling in " +
        "source/app/util/tikz-render.ts is written against that guarantee.",
    );
  }
}

/**
 * Renders one TikZ figure to inline SVG through the vendored pandoc filter.
 */
export async function renderTikz(
  request: TikzRenderRequest,
  config: TikzRenderConfig,
): Promise<TikzRenderResult> {
  const env = config.env;

  const missing: string[] = [];
  for (const tool of REQUIRED_TOOLS) {
    const probe = await probeTool(tool, env);
    if (probe.status === "probe-failed") {
      // The remaining tools are deliberately not probed: with one probe broken
      // the toolchain status is unknown, and a partial "missing" list would
      // read as a complete diagnosis.
      return { ok: false, kind: "toolchain-probe-failed", tool, code: probe.code };
    }
    if (probe.status === "absent") {
      missing.push(tool);
    }
  }
  if (missing.length > 0) {
    return { ok: false, kind: "missing-tools", missing };
  }

  await mkdir(config.cacheDir, { recursive: true });

  // pandoc's markdown reader classifies a \begin{…} block as RawBlock latex
  // and a ```tikz fence as CodeBlock tikz — exactly the two surfaces the
  // filter handles.
  const markdown =
    request.kind === "raw" ? `${request.source}\n` : `\`\`\`tikz\n${request.source}\n\`\`\`\n`;

  const filterPath = path.join(config.tikzAssetDir, "filters/tikzcd.lua");
  const renderEnv: NodeJS.ProcessEnv = {
    ...env,
    PANDOC_DIR: config.tikzAssetDir,
    FIGURE_TEMPLATE_FILE: path.join(config.tikzAssetDir, "templates/standalone-tikz.tex"),
    SVG_DIR: config.cacheDir,
    FIGURES_DIR: config.cacheDir,
    PANDOC_DOC_PATH: request.docPath,
  };

  const outcome = await new Promise<PandocProcessOutcome>((resolve, reject) => {
    const proc = spawn("pandoc", ["-f", "markdown", "-t", "html", "--lua-filter", filterPath], {
      env: renderEnv,
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    proc.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    proc.once("error", reject);
    proc.once("close", (exitCode, signal) => {
      if (signal !== null) {
        resolve({ ended: "signal", signal, stdout: out, stderr: err });
        return;
      }
      assertExitedWithCode(exitCode, signal);
      resolve({ ended: "exit", code: exitCode, stdout: out, stderr: err });
    });
    proc.stdin.end(markdown);
  });

  if (outcome.ended === "signal") {
    // The render never ran to completion, so whatever landed on stderr is a
    // partial transcript, not a diagnostic about the figure. Reporting the
    // signal keeps a kill distinguishable from pandoc failing on its own.
    return { ok: false, kind: "render-terminated", signal: outcome.signal, log: outcome.stderr };
  }

  const errors: TikzCompileError[] = [];
  for (const line of outcome.stderr.split("\n")) {
    const match = ERROR_MARKER_RE.exec(line);
    if (match !== null) {
      errors.push({ line: Number(match[1]), message: match[2], sourceLine: match[3] });
    }
  }

  if (errors.length > 0) {
    return { ok: false, kind: "compile-error", errors, log: outcome.stderr };
  }

  if (outcome.code !== 0) {
    return { ok: false, kind: "pandoc-error", log: outcome.stderr };
  }

  const svgMarkup = outcome.stdout.match(/<svg[\s\S]*?<\/svg>/)?.[0];
  if (svgMarkup === undefined) {
    // The HTML writer omitted the figure: the filter dropped a block that did
    // not compile without a bang-error block to cite (or produced no SVG).
    return { ok: false, kind: "compile-error", errors: [], log: outcome.stderr };
  }

  // The filter caches by an internal template-folded hash; the lightbox file
  // is addressed by the request itself so the widget can open it by path.
  const requestHash = createHash("sha1").update(`${request.kind}\0${request.source}`).digest("hex");
  const svgPath = path.join(config.cacheDir, `lightbox-${requestHash}.svg`);
  await writeFile(svgPath, `<?xml version="1.0" encoding="UTF-8"?>\n${svgMarkup}\n`);

  // Reaching here means the pandoc output carries an <svg>…</svg>: that is the
  // guarantee consumers of an ok result are entitled to assume of `html`.
  return { ok: true, html: outcome.stdout, svgPath };
}
