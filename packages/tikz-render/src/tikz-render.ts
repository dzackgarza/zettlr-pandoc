/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikZ render service
 * CVM-Role:        Utility Function
 * License:         GNU GPL v3
 *
 * Description:     Renders a TikZ figure (raw \begin{tikzcd}/\begin{tikzpicture}
 *                  block or a ```tikz/```tikzcd code fence) to inline SVG by running the
 *                  tikzcd.lua filter through pandoc. The caller supplies the
 *                  filter data tree and, independently, the user-owned
 *                  standalone template which injects packages/macros. The
 *                  filter compiles via pdflatex and
 *                  pdf2svg with a content-addressed cache, namespaces SVG ids,
 *                  and emits one machine-parseable marker line per
 *                  figure-compile error; this module owns the process
 *                  plumbing and translates every outcome into a typed result —
 *                  missing tools, a toolchain probe that failed for a reason
 *                  other than absence, compile failures, a render killed by
 *                  a signal and a render that passed its time limit are loud
 *                  and distinct, never silence. The environment every child
 *                  runs under is supplied by the caller, never read from
 *                  ambient process state. A render that ends leaves no
 *                  process and no scratch file, however it ends.
 *
 * END HEADER
 */

import { Semaphore } from "async-mutex";
import { type ChildProcess, spawn } from "child_process";
import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { maskTexComments, texCommandDeclarationEntries } from "./tex-command-declarations";

const REQUIRED_TIKZ_DATA_FILES = ["filters/tikzcd.lua", "filters/utilities.lua"] as const;

/**
 * Handshake between the app and the shared tikzcd.lua implementation. Bump
 * when the app starts relying on filter behavior that an older shared checkout
 * cannot provide; startup preflight and explicit data-dir resolution both fail
 * loudly on a mismatch instead of silently degrading the live-preview contract.
 */
export const TIKZ_RENDER_PROTOCOL = 3;
const TIKZ_RENDER_PROTOCOL_RE = /^-- ZETTLR_TIKZ_RENDER_PROTOCOL=(\d+)$/m;

function hasTikzDataFiles(dataDir: string): boolean {
  return REQUIRED_TIKZ_DATA_FILES.every((relativePath) =>
    existsSync(path.join(dataDir, relativePath)),
  );
}

export function tikzRenderProtocolVersion(dataDir: string): number | undefined {
  const filterPath = path.join(dataDir, "filters", "tikzcd.lua");
  if (!existsSync(filterPath)) {
    return undefined;
  }
  const match = TIKZ_RENDER_PROTOCOL_RE.exec(readFileSync(filterPath, "utf8"));
  return match === null ? undefined : Number(match[1]);
}

function assertSupportedTikzDataDir(dataDir: string, label: string): void {
  if (!hasTikzDataFiles(dataDir)) {
    throw new Error(`${label} ${dataDir} is missing ` + REQUIRED_TIKZ_DATA_FILES.join(" or "));
  }
  const protocol = tikzRenderProtocolVersion(dataDir);
  if (protocol !== TIKZ_RENDER_PROTOCOL) {
    throw new Error(
      `${label} ${dataDir} uses TikZ renderer protocol ${protocol === undefined ? "unknown" : protocol}, ` +
        `but the TikZ renderer requires protocol ${TIKZ_RENDER_PROTOCOL}. Update the TikZ filter files in that directory.`,
    );
  }
}

/**
 * Resolves the single Pandoc data tree used by editor TikZ rendering.
 *
 * An explicit setting is authoritative and must carry the filter and its Lua
 * dependency. The standalone TeX template is intentionally NOT part of this
 * data-tree contract: resolveTikzTemplatePath owns that independently under
 * ~/.pandoc, so a configured filter tree cannot accidentally become a second
 * preamble owner. Without an explicit data tree, a maintained ~/.pandoc filter
 * checkout wins; without it rendering fails loudly rather than substituting a
 * private filter implementation.
 */
export function resolveTikzDataDir(configuredDir: string, homeDir: string): string {
  if (configuredDir !== "") {
    assertSupportedTikzDataDir(configuredDir, "Configured TikZ data directory");
    return configuredDir;
  }

  const userPandocDir = path.join(homeDir, ".pandoc");
  if (hasTikzDataFiles(userPandocDir)) {
    assertSupportedTikzDataDir(userPandocDir, "Shared Pandoc data tree");
    return userPandocDir;
  }

  throw new Error(
    `TikZ rendering requires the shared Pandoc data tree ${userPandocDir} to contain ` +
      REQUIRED_TIKZ_DATA_FILES.join(" and ") +
      "; the renderer does not substitute a private filter copy for missing shared Pandoc configuration.",
  );
}

/**
 * The editor preview always compiles snippets through the user's maintained
 * standalone template. The renderer does not synthesize a preamble or inject a
 * second macro set: ~/.pandoc owns that authoring environment.
 */
export function resolveTikzTemplatePath(homeDir: string): string {
  const templatePath = path.join(homeDir, ".pandoc", "templates", "standalone-tikz.tex");
  if (!existsSync(templatePath)) {
    throw new Error(
      `TikZ live preview requires the owned template ${templatePath}; ` +
        "create/restore ~/.pandoc/templates/standalone-tikz.tex so packages and user macros have one source of truth.",
    );
  }
  return templatePath;
}

const TEX_INPUT_RE = /\\(?:input|include)\s*\{([^}]+)\}/gu;
const TEX_PACKAGE_RE = /\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\s*\{([^}]+)\}/gu;

function localTexFileIndex(root: string): string[] {
  const result: string[] = [];
  if (!existsSync(root)) {
    return result;
  }
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile() && /\.(?:tex|sty|cls)$/iu.test(entry.name)) {
        result.push(absolute);
      }
    }
  };
  visit(root);
  return result;
}

function resolveLocalTexReference(
  reference: string,
  extension: ".tex" | ".sty",
  currentDirectory: string,
  roots: string[],
  index: string[],
): string[] {
  const normalized = reference.trim();
  if (normalized === "" || normalized.includes("$")) {
    return [];
  }
  const withExtension = path.extname(normalized) === "" ? `${normalized}${extension}` : normalized;
  const direct = [
    path.resolve(currentDirectory, withExtension),
    ...roots.map((root) => path.resolve(root, withExtension)),
  ].filter((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  if (direct.length > 0) {
    return [...new Set(direct)];
  }

  const suffix = withExtension.replaceAll("\\", "/").replace(/^\.\//u, "");
  const basename = path.basename(withExtension);
  return index.filter((candidate) => {
    const unix = candidate.replaceAll("\\", "/");
    return unix.endsWith(`/${suffix}`) || path.basename(candidate) === basename;
  });
}

interface TikzTemplateSource {
  filePath: string;
  source: string;
}

/**
 * Walk the same local template/include graph that the TikZ compiler sees.
 * System TeX packages intentionally remain outside this graph: the editor's
 * standard LaTeX catalogue owns those, while this traversal is only for the
 * user's maintained ~/.pandoc template/styles tree.
 */
function tikzTemplateSources(templatePath: string): TikzTemplateSource[] {
  const pandocRoot = path.dirname(path.dirname(templatePath));
  const stylesRoot = path.join(pandocRoot, "styles");
  const templatesRoot = path.dirname(templatePath);
  const roots = [stylesRoot, templatesRoot];
  const index = [...localTexFileIndex(stylesRoot), ...localTexFileIndex(templatesRoot)];
  const queue = [templatePath];
  const visited = new Set<string>();
  const sources: TikzTemplateSource[] = [];

  while (queue.length > 0) {
    const filePath = queue.shift()!;
    const resolvedFile = path.resolve(filePath);
    if (visited.has(resolvedFile) || !existsSync(resolvedFile)) {
      continue;
    }
    visited.add(resolvedFile);
    const source = readFileSync(resolvedFile, "utf8");
    sources.push({ filePath: resolvedFile, source });

    // TeX loads no file that a comment names.
    const visible = maskTexComments(source);
    for (const match of visible.matchAll(TEX_INPUT_RE)) {
      queue.push(
        ...resolveLocalTexReference(match[1], ".tex", path.dirname(resolvedFile), roots, index),
      );
    }
    for (const match of visible.matchAll(TEX_PACKAGE_RE)) {
      for (const packageName of match[1]
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)) {
        queue.push(
          ...resolveLocalTexReference(
            packageName,
            ".sty",
            path.dirname(resolvedFile),
            roots,
            index,
          ),
        );
      }
    }
  }

  return sources;
}

/**
 * Fingerprint the complete user-owned TeX dependency graph that supplies the
 * standalone TikZ preamble. The literal template is not enough: it normally
 * contains only `\usepackage{dzg-tikz}`, while the macro definitions that
 * affect rendered output live in the package's transitive \input graph.
 *
 * Paths are relative to ~/.pandoc rather than checkout-specific absolute
 * paths. Sorting makes the digest independent of filesystem enumeration order;
 * including both relative path and bytes means renaming, adding, removing or
 * editing any reachable local dependency invalidates the cache key.
 */
export function tikzTemplateDependencyHash(templatePath: string): string {
  const pandocRoot = path.dirname(path.dirname(templatePath));
  const sources = tikzTemplateSources(templatePath)
    .map(({ filePath, source }) => ({
      relativePath: path.relative(pandocRoot, filePath).replaceAll(path.sep, "/"),
      source,
    }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const hash = createHash("sha1");
  for (const entry of sources) {
    hash.update(entry.relativePath);
    hash.update("\0");
    hash.update(entry.source);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Enumerate user-defined control words visible to the owned TikZ template.
 * Only files under the user's template/styles tree are followed; system TeX
 * packages are represented by the maintained standard LaTeX catalogue instead
 * of recursively indexing an entire TeX Live installation.
 */
export function tikzTemplateCommands(templatePath: string): string[] {
  const commands = new Set<string>();
  for (const { source } of tikzTemplateSources(templatePath)) {
    for (const declaration of texCommandDeclarationEntries(source)) {
      commands.add(declaration.name);
    }
  }

  return [...commands].sort((a, b) => a.localeCompare(b));
}

export interface TikzTemplateCompletion {
  label: string;
  /** The arity of the declaration; absent for an xparse declaration, whose argument specification is not read. */
  argumentCount?: number;
  /** The authored declaration line, for completion documentation only. */
  declaration?: string;
  /** User-owned source file that declared the command. */
  sourceFile?: string;
}

/**
 * Completion metadata for the same user-owned template/include graph, read
 * by the one reader of TeX declarations (`texCommandDeclarationEntries`).
 * When the arity is not known, the command remains searchable but no
 * argument scaffold is fabricated.
 */
export function tikzTemplateCompletions(templatePath: string): TikzTemplateCompletion[] {
  const completions = new Map<string, TikzTemplateCompletion>();
  for (const { filePath, source } of tikzTemplateSources(templatePath)) {
    for (const entry of texCommandDeclarationEntries(source)) {
      completions.set(entry.name, {
        label: entry.name,
        argumentCount: entry.argumentCount,
        declaration: entry.declaration === "" ? undefined : entry.declaration,
        sourceFile: filePath,
      });
    }
  }
  return [...completions.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export type TikzCompletionIPCResponse = ReturnType<typeof tikzTemplateCompletions>;

export interface TikzRenderRequest {
  /**
   * The figure source. For 'raw' this is the complete
   * \begin{tikzcd}/\begin{tikzpicture} … \end{…} block; for 'fence' it is the
   * body of a ```tikz or ```tikzcd code fence. Snippet fences use the owned standalone
   * template; the legacy inline renderer also accepts a full LaTeX document,
   * which intentionally owns its own preamble and is not offered as a
   * microlocal template-owned live-preview target.
   */
  source: string;
  kind: "raw" | "fence";
  /** Source language. tikzcd fences are template-owned snippets, not standalone TeX documents. */
  language: "tikz" | "tikzcd";
  /**
   * The document the figure was authored in; the filter resolves the figure's
   * \input{…} against this file's directory.
   *
   * There is exactly one representation of "this buffer has no on-disk path":
   * the empty string. That is what the editor configuration stores in
   * `metadata.path` for an unsaved buffer (see getDefaultConfig), and it is
   * what the shared filter branches on (`doc_path ~= ""` selects the
   * document root, otherwise the process working directory). The field is
   * therefore always supplied — a caller with no path passes the
   * configuration's own value, it does not omit the field.
   */
  docPath: string;
  /** Normal renders use the filter cache; an explicit rerender bypasses it. */
  cachePolicy?: "use" | "refresh";
}

export interface TikzRenderConfig {
  /** The resolved shared/user-owned Pandoc data tree. */
  tikzAssetDir: string;
  /** User-owned standalone template used to wrap snippet figures. */
  templatePath: string;
  /** The host-owned render cache; SVGs land and persist here. */
  cacheDir: string;
  /** Effective centralized source tree used for authored figure inputs. */
  figuresSourceDir?: string;
  /**
   * The time that one render may take. A render that takes longer is stopped
   * with each process that it started and reports 'render-timeout'.
   */
  timeoutMs: number;
  /**
   * The environment every child process of this render runs under. It decides
   * which pandoc, pdflatex and pdf2svg are found, so it is an input to the
   * render, not an ambient condition the service may read for itself: the
   * caller states which environment it is asking for and that decision is
   * recorded at the call site.
   */
  env: NodeJS.ProcessEnv;
}

/**
 * Who waits for a render. A preview is a figure that the author looks at; a
 * background render is work that the author did not start (the lint).
 */
export type TikzRenderPriority = "preview" | "background";

const RENDER_PRIORITY: Record<TikzRenderPriority, number> = { preview: 1, background: 0 };

export interface TikzCompileError {
  /** 1-based line within the figure body. */
  line: number;
  /** The LaTeX bang-error message. */
  message: string;
  /** The verbatim figure-body source line the error maps to. */
  sourceLine: string;
}

/**
 * Reads the base document font size that TeX uses for ordinary diagram labels.
 * Standard LaTeX classes default to 10pt; standalone follows that convention.
 * A document/template may opt into another point size through documentclass.
 */
export function latexBaseFontSizePt(latexSource: string): number {
  const documentClass = /\\documentclass\s*(?:\[([^\]]*)\])?\s*\{[^}]+\}/.exec(latexSource);
  if (documentClass === null) {
    return 10;
  }
  const pointSize = documentClass[1]
    ?.split(",")
    .map((option) => option.trim())
    .find((option) => /^\d+(?:\.\d+)?pt$/.test(option));
  if (pointSize === undefined) {
    return 10;
  }
  const parsed = Number(pointSize.slice(0, -2));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

function requestBaseFontSizePt(request: TikzRenderRequest, config: TikzRenderConfig): number {
  const isFullDocument =
    request.kind === "fence" &&
    request.language === "tikz" &&
    /\\documentclass/.test(request.source) &&
    /\\begin\s*\{document\}/.test(request.source);
  const latexSource = isFullDocument ? request.source : readFileSync(config.templatePath, "utf8");
  return latexBaseFontSizePt(latexSource);
}

export type TikzRenderResult =
  | {
      ok: true;
      html: string;
      svg: string;
      svgPath: string;
      /** TeX point size corresponding to one ordinary diagram-label em. */
      texFontSizePt: number;
    }
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
   * The render process was killed before it could finish (OOM killer, an
   * interrupt). This is not pandoc reporting a problem: no diagnostic was
   * produced and nothing about the figure is known. The signal that ended it
   * is the information that distinguishes this outcome.
   */
  | { ok: false; kind: "render-terminated"; signal: NodeJS.Signals; log: string }
  /**
   * The render passed the time limit of its configuration and was stopped.
   * Nothing about the figure is known; a TeX loop that does not end is the
   * usual cause.
   */
  | { ok: false; kind: "render-timeout"; timeoutMs: number; log: string };

/**
 * How the pandoc child process ended. Node's 'close' event carries exactly one
 * of (code, signal): a process either exits with a status or is terminated by
 * a signal. Both are real outcomes, so both are carried as their own case. A
 * process that this module stopped at the time limit is the third case.
 */
type PandocProcessOutcome =
  | { ended: "exit"; code: number; stdout: string; stderr: string }
  | { ended: "signal"; signal: NodeJS.Signals; stdout: string; stderr: string }
  | { ended: "timeout"; stderr: string };

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
 * The probes that found their tool, by PATH and tool name. A tool that was
 * found stays installed while the host runs, so one render in a session pays
 * for the probe. A tool that was not found is probed again at the next render:
 * the author may install it while the app stays open.
 */
const availableTools = new Map<string, Promise<ToolProbe>>();

async function probeToolOnce(tool: string, env: NodeJS.ProcessEnv): Promise<ToolProbe> {
  if (env.PATH === undefined) {
    throw new Error(
      `tikz-render: the render environment has no PATH, so ${tool} cannot be found in it.`,
    );
  }
  const key = `${env.PATH}\0${tool}`;
  const known = availableTools.get(key);
  if (known !== undefined) {
    return await known;
  }
  const probe = probeTool(tool, env);
  availableTools.set(key, probe);
  try {
    const result = await probe;
    if (result.status !== "available") {
      availableTools.delete(key);
    }
    return result;
  } catch (error) {
    availableTools.delete(key);
    throw error;
  }
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
        "packages/tikz-render/src/tikz-render.ts is written against that guarantee.",
    );
  }
}

/** The time between SIGTERM and SIGKILL for a render that passed its limit. */
const KILL_GRACE_MS = 2_000;

/** A render that has not ended: its pandoc process and its scratch files. */
interface ActiveRender {
  pandoc: ChildProcess;
  scratchDir: string;
}

// The renders that have not ended. The pandoc process of a render leads a
// process group of its own (`detached`), because a signal to one process does
// not reach the processes that it started: the shell and the TeX of the filter
// (https://nodejs.org/api/child_process.html#subprocesskillsignal). A signal
// to the group reaches all of them, as `kill -- -PGID` does.
const activeRenders = new Set<ActiveRender>();

/**
 * Signals each process of a render. A group in which no process is left has
 * nothing to stop: kill(2) answers ESRCH for it, and that answer is no error
 * (https://man7.org/linux/man-pages/man2/kill.2.html).
 */
function signalRender(pandoc: ChildProcess, signal: NodeJS.Signals): void {
  if (pandoc.pid === undefined) {
    // The process did not start.
    return;
  }
  try {
    process.kill(-pandoc.pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}

// A render is apart from the process group of the app, so a signal to the app
// does not reach it. The exit of the app stops the renders that have not
// ended and removes their scratch files.
process.on("exit", () => {
  for (const render of activeRenders) {
    signalRender(render.pandoc, "SIGKILL");
    // A stopped process can write one more file while its directory is read.
    rmSync(render.scratchDir, { recursive: true, maxRetries: 5, retryDelay: 20 });
  }
});

/**
 * Runs pandoc with the filter on one figure and says how the process ended.
 * The promise settles when no process of the render is left: the fourth pipe
 * has no reader and no writer, each process of the render inherits it, and
 * Node gives 'close' only after the process has ended and each of its pipes
 * is closed (https://nodejs.org/api/child_process.html#event-close).
 */
async function runFilter(
  markdown: string,
  filterPath: string,
  env: NodeJS.ProcessEnv,
  scratchDir: string,
  timeoutMs: number,
): Promise<PandocProcessOutcome> {
  return await new Promise<PandocProcessOutcome>((resolve, reject) => {
    const pandoc = spawn("pandoc", ["-f", "markdown", "-t", "html", "--lua-filter", filterPath], {
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    const { stdin, stdout, stderr } = pandoc;
    if (stdin === null || stdout === null || stderr === null) {
      throw new Error("tikz-render: Node gave no pipe for a stream of pandoc that was asked for.");
    }
    const render: ActiveRender = { pandoc, scratchDir };
    activeRenders.add(render);

    let out = "";
    let err = "";
    let timedOut = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const limitTimer = setTimeout(() => {
      timedOut = true;
      signalRender(pandoc, "SIGTERM");
      graceTimer = setTimeout(() => {
        signalRender(pandoc, "SIGKILL");
      }, KILL_GRACE_MS);
    }, timeoutMs);
    const ended = (): void => {
      activeRenders.delete(render);
      clearTimeout(limitTimer);
      clearTimeout(graceTimer);
    };

    stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    pandoc.once("error", (spawnError: Error) => {
      ended();
      reject(spawnError);
    });
    pandoc.once("exit", (_exitCode, signal) => {
      // A pandoc that was stopped did not wait for the shell and the TeX
      // that its filter started. Their work has no reader.
      if (signal !== null || timedOut) {
        signalRender(pandoc, "SIGKILL");
      }
    });
    pandoc.once("close", (exitCode, signal) => {
      ended();
      if (timedOut) {
        resolve({ ended: "timeout", stderr: err });
        return;
      }
      if (signal !== null) {
        resolve({ ended: "signal", signal, stdout: out, stderr: err });
        return;
      }
      assertExitedWithCode(exitCode, signal);
      resolve({ ended: "exit", code: exitCode, stdout: out, stderr: err });
    });
    stdin.end(markdown);
  });
}

// One render at a time in the process: each caller of `renderTikz` (the
// preview of the editor, the lint) waits here. Two renders therefore never
// write one file of the cache at the same time, and a figure that a second
// render asks for while the first compiles it is a cache hit for the second.
// A preview goes before the background renders that wait.
const renderTurns = new Semaphore(1);

/**
 * Renders one TikZ figure to inline SVG through the shared Pandoc filter,
 * after the renders that went before it in the process (`renderTurns`).
 */
export async function renderTikz(
  request: TikzRenderRequest,
  config: TikzRenderConfig,
  priority: TikzRenderPriority,
): Promise<TikzRenderResult> {
  return await renderTurns.runExclusive(
    async () => await renderOneFigure(request, config),
    1,
    RENDER_PRIORITY[priority],
  );
}

async function renderOneFigure(
  request: TikzRenderRequest,
  config: TikzRenderConfig,
): Promise<TikzRenderResult> {
  const env = config.env;
  const texFontSizePt = requestBaseFontSizePt(request, config);
  // Recompute on every request. The macro/style files are intentionally owned
  // outside the host and may change while the app remains open; caching
  // this fingerprint in-process would recreate the exact stale-preview bug the
  // persistent figure cache is meant to avoid.
  const renderContextHash = tikzTemplateDependencyHash(config.templatePath);

  const missing: string[] = [];
  for (const tool of REQUIRED_TOOLS) {
    const probe = await probeToolOnce(tool, env);
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
    request.kind === "raw"
      ? `${request.source.trim()}\n`
      : request.language === "tikzcd"
        ? `\\begin{tikzcd}\n${request.source}\n\\end{tikzcd}\n`
        : `\`\`\`tikz\n${request.source}\n\`\`\`\n`;

  const filterPath = path.join(config.tikzAssetDir, "filters/tikzcd.lua");
  // pandoc makes the scratch directory of the filter below TMPDIR, and the
  // filter removes it when TeX has ended. A filter that was stopped removes
  // nothing, so each render has a temporary directory of its own, which this
  // function removes.
  const scratchDir = await mkdtemp(path.join(tmpdir(), "tikz-render-"));
  const renderEnv: NodeJS.ProcessEnv = {
    ...env,
    TMPDIR: scratchDir,
    PANDOC_DIR: config.tikzAssetDir,
    FIGURE_TEMPLATE_FILE: config.templatePath,
    // The template is user-owned under ~/.pandoc and may load packages/macros
    // from its sibling styles tree. Keep that lookup owned by the same tree
    // even when the filter itself comes from an explicitly configured or
    // bundled data directory.
    FIGURE_STYLES_DIR: path.join(path.dirname(path.dirname(config.templatePath)), "styles"),
    FIGURES_SOURCE_DIR:
      config.figuresSourceDir ??
      env.FIGURES_SOURCE_DIR ??
      path.join(path.dirname(path.dirname(config.templatePath)), "figures"),
    SVG_DIR: config.cacheDir,
    FIGURES_DIR: config.cacheDir,
    PANDOC_DOC_PATH: request.docPath,
    TIKZ_RENDER_CONTEXT_HASH: renderContextHash,
    TIKZ_FORCE_REBUILD: request.cachePolicy === "refresh" ? "1" : "0",
  };

  const outcome = await runFilter(
    markdown,
    filterPath,
    renderEnv,
    scratchDir,
    config.timeoutMs,
  ).finally(async () => {
    await rm(scratchDir, { recursive: true });
  });

  if (outcome.ended === "timeout") {
    return {
      ok: false,
      kind: "render-timeout",
      timeoutMs: config.timeoutMs,
      log: outcome.stderr,
    };
  }

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
      const reportedLine = Number(match[1]);
      const line =
        request.kind === "fence" && request.language === "tikzcd"
          ? Math.max(1, reportedLine - 1)
          : reportedLine;
      errors.push({ line, message: match[2], sourceLine: match[3] });
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

  // The viewer source path is itself content-sensitive. In particular an
  // explicit cache-bypassing refresh may discover an output change caused by a
  // dependency outside the graph above (for example a system TeX package or a
  // referenced graphic). If the path stayed request-addressed, Vue/Viewer.js
  // would see the same prop and could keep displaying its previous image even
  // though pdflatex really reran. Fold the actual SVG bytes into the path so a
  // changed render necessarily reaches the existing Viewer.js instance.
  const requestHash = createHash("sha1")
    .update(
      `${request.kind}\0${request.language}\0${request.docPath}\0${request.source}\0${renderContextHash}\0${svgMarkup}`,
    )
    .digest("hex");
  const svgPath = path.join(config.cacheDir, `lightbox-${requestHash}.svg`);
  await writeFile(svgPath, `<?xml version="1.0" encoding="UTF-8"?>\n${svgMarkup}\n`);

  // Reaching here means the pandoc output carries an <svg>…</svg>: that is the
  // guarantee consumers of an ok result are entitled to assume of `html`.
  return { ok: true, html: outcome.stdout, svg: svgMarkup, svgPath, texFontSizePt };
}
