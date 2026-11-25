import { describeProbe, probeTool } from "@dzack/external-process/probe-tool";
import { describeOutcome, runProcess } from "@dzack/external-process/run-process";
import { Semaphore } from "async-mutex";
import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { maskTexComments, texCommandDeclarationEntries } from "./tex-command-declarations";

const TIKZ_FILTER = "filters/tikzcd.lua";

export const TIKZ_RENDER_PROTOCOL = 3;
const TIKZ_RENDER_PROTOCOL_LINE_RE = /^local ZETTLR_TIKZ_RENDER_PROTOCOL = (\d+)$/;

function hasTikzFilter(dataDir: string): boolean {
  return existsSync(path.join(dataDir, TIKZ_FILTER));
}

export function tikzRenderProtocolVersion(dataDir: string): number | undefined {
  const filterPath = path.join(dataDir, TIKZ_FILTER);
  if (!existsSync(filterPath)) {
    return undefined;
  }
  const firstLine = readFileSync(filterPath, "utf8").split("\n", 1)[0];
  const match = TIKZ_RENDER_PROTOCOL_LINE_RE.exec(firstLine);
  return match === null ? undefined : Number(match[1]);
}

function assertSupportedTikzDataDir(dataDir: string, label: string): void {
  if (!hasTikzFilter(dataDir)) {
    throw new Error(`${label} ${dataDir} is missing ${TIKZ_FILTER}`);
  }
  const protocol = tikzRenderProtocolVersion(dataDir);
  if (protocol !== TIKZ_RENDER_PROTOCOL) {
    throw new Error(
      `${label} ${dataDir} uses TikZ renderer protocol ${protocol === undefined ? "unknown" : protocol}, ` +
        `but the TikZ renderer requires protocol ${TIKZ_RENDER_PROTOCOL}. Update the TikZ filter in that directory.`,
    );
  }
}

export function resolveTikzDataDir(configuredDir: string, homeDir: string): string {
  if (configuredDir !== "") {
    assertSupportedTikzDataDir(configuredDir, "Configured TikZ data directory");
    return configuredDir;
  }

  const userPandocDir = path.join(homeDir, ".pandoc");
  if (hasTikzFilter(userPandocDir)) {
    assertSupportedTikzDataDir(userPandocDir, "Shared Pandoc data tree");
    return userPandocDir;
  }

  throw new Error(
    `TikZ rendering requires the shared Pandoc data tree ${userPandocDir} to contain ${TIKZ_FILTER}` +
      "; the renderer does not substitute a private filter copy for missing shared Pandoc configuration.",
  );
}

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
  argumentCount?: number;
  declaration?: string;
  sourceFile?: string;
}

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
  source: string;
  kind: "raw" | "fence";
  language: "tikz" | "tikzcd";
  docPath: string;
  cachePolicy?: "use" | "refresh";
}

export interface TikzRenderConfig {
  tikzAssetDir: string;
  templatePath: string;
  cacheDir: string;
  figuresSourceDir?: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}

export type TikzRenderPriority = "preview" | "background";

const RENDER_PRIORITY: Record<TikzRenderPriority, number> = { preview: 1, background: 0 };

export interface TikzCompileError {
  line: number;
  message: string;
  sourceLine: string;
}

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
      texFontSizePt: number;
    }
  | { ok: false; kind: "missing-tools"; missing: string[] }
  | { ok: false; kind: "toolchain-probe-failed"; tool: string; cause: string }
  | { ok: false; kind: "compile-error"; errors: TikzCompileError[]; log: string }
  | { ok: false; kind: "pandoc-error"; log: string }
  | { ok: false; kind: "render-terminated"; signal: NodeJS.Signals; log: string }
  | { ok: false; kind: "render-timeout"; timeoutMs: number; log: string };

const REQUIRED_TOOLS = ["pandoc", "pdflatex", "pdf2svg"];

const ERROR_MARKER_RE = /^\[tikzcd-figure-error\] (\d+)\|([^|]*)\|(.*)$/;

const activeScratchDirs = new Set<string>();

process.on("exit", () => {
  for (const scratchDir of activeScratchDirs) {
    rmSync(scratchDir, { recursive: true, maxRetries: 5, retryDelay: 20 });
  }
});

const renderTurns = new Semaphore(1);

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
  const renderContextHash = tikzTemplateDependencyHash(config.templatePath);

  const missing: string[] = [];
  for (const tool of REQUIRED_TOOLS) {
    const probe = await probeTool(tool, env);
    if (probe.status === "available") {
      continue;
    }
    if (probe.status === "not-started" && probe.reason === "absent") {
      missing.push(tool);
      continue;
    }
    return { ok: false, kind: "toolchain-probe-failed", tool, cause: describeProbe(tool, probe) };
  }
  if (missing.length > 0) {
    return { ok: false, kind: "missing-tools", missing };
  }

  await mkdir(config.cacheDir, { recursive: true });

  const markdown =
    request.kind === "raw"
      ? `${request.source.trim()}\n`
      : request.language === "tikzcd"
        ? `\\begin{tikzcd}\n${request.source}\n\\end{tikzcd}\n`
        : `\`\`\`tikz\n${request.source}\n\`\`\`\n`;

  const filterPath = path.join(config.tikzAssetDir, "filters/tikzcd.lua");
  const scratchDir = await mkdtemp(path.join(tmpdir(), "tikz-render-"));
  activeScratchDirs.add(scratchDir);
  const renderEnv: NodeJS.ProcessEnv = {
    ...env,
    TMPDIR: scratchDir,
    PANDOC_DIR: config.tikzAssetDir,
    FIGURE_TEMPLATE_FILE: config.templatePath,
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

  const outcome = await runProcess({
    command: "pandoc",
    args: ["-f", "markdown", "-t", "html", "--lua-filter", filterPath],
    env: renderEnv,
    input: markdown,
    timeLimitMs: config.timeoutMs,
    waitForGroup: true,
  }).finally(async () => {
    activeScratchDirs.delete(scratchDir);
    await rm(scratchDir, { recursive: true });
  });

  if (outcome.ended === "not-started") {
    throw new Error(`tikz-render: ${describeOutcome("pandoc", outcome)}`);
  }

  if (outcome.ended === "timeout") {
    return {
      ok: false,
      kind: "render-timeout",
      timeoutMs: config.timeoutMs,
      log: outcome.stderr,
    };
  }

  if (outcome.ended === "signal") {
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
    return { ok: false, kind: "compile-error", errors: [], log: outcome.stderr };
  }

  const requestHash = createHash("sha1")
    .update(
      `${request.kind}\0${request.language}\0${request.docPath}\0${request.source}\0${renderContextHash}\0${svgMarkup}`,
    )
    .digest("hex");
  const svgPath = path.join(config.cacheDir, `lightbox-${requestHash}.svg`);
  await writeFile(svgPath, `<?xml version="1.0" encoding="UTF-8"?>\n${svgMarkup}\n`);

  return { ok: true, html: outcome.stdout, svg: svgMarkup, svgPath, texFontSizePt };
}
