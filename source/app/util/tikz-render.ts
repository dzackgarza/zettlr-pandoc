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
 *                  missing tools, compile failures and a render killed by a
 *                  signal are loud and distinct, never silence.
 *
 * END HEADER
 */

import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { mkdir, writeFile } from 'fs/promises'
import path from 'path'

export interface TikzRenderRequest {
  /**
   * The figure source. For 'raw' this is the complete
   * \begin{tikzcd}/\begin{tikzpicture} … \end{…} block; for 'fence' it is the
   * body of a ```tikz code fence (a complete standalone document).
   */
  source: string
  kind: 'raw'|'fence'
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
  docPath: string
}

export interface TikzRenderConfig {
  /** The app-owned vendored asset tree (filters/, templates/, styles/). */
  tikzAssetDir: string
  /** The app-owned render cache; SVGs land and persist here. */
  cacheDir: string
  /** Environment override, primarily for tests. Defaults to process.env. */
  env?: NodeJS.ProcessEnv
}

export interface TikzCompileError {
  /** 1-based line within the figure body. */
  line: number
  /** The LaTeX bang-error message. */
  message: string
  /** The verbatim figure-body source line the error maps to. */
  sourceLine: string
}

export type TikzRenderResult =
  { ok: true, html: string, svgPath: string } |
  { ok: false, kind: 'missing-tools', missing: string[] } |
  { ok: false, kind: 'compile-error', errors: TikzCompileError[], log: string } |
  { ok: false, kind: 'pandoc-error', log: string } |
  /**
   * The render process was killed before it could finish (OOM killer, a
   * timeout kill, an interrupt). This is not pandoc reporting a problem: no
   * diagnostic was produced and nothing about the figure is known. The signal
   * that ended it is the information that distinguishes this outcome.
   */
  { ok: false, kind: 'render-terminated', signal: NodeJS.Signals, log: string }

/**
 * How the pandoc child process ended. Node's 'close' event carries exactly one
 * of (code, signal): a process either exits with a status or is terminated by
 * a signal. Both are real outcomes, so both are carried as their own case.
 */
type PandocProcessOutcome =
  { ended: 'exit', code: number, stdout: string, stderr: string } |
  { ended: 'signal', signal: NodeJS.Signals, stdout: string, stderr: string }

/** The tools the filter shells out to, checked before any render. */
const REQUIRED_TOOLS = [ 'pandoc', 'pdflatex', 'pdf2svg' ]

/** One marker line per figure-compile error: body-line|message|source. */
const ERROR_MARKER_RE = /^\[tikzcd-figure-error\] (\d+)\|([^|]*)\|(.*)$/

/**
 * Resolves whether an executable is reachable in the given environment's
 * PATH. spawn with ENOENT is the discriminator — exit codes are irrelevant.
 */
async function toolAvailable (tool: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return await new Promise<boolean>(resolve => {
    const probe = spawn(tool, ['--version'], { env, stdio: 'ignore' })
    probe.once('error', () => resolve(false))
    probe.once('spawn', () => {
      probe.once('close', () => resolve(true))
      // --version variants that wait on stdin must not hang the probe.
      probe.kill()
      resolve(true)
    })
  })
}

/**
 * States Node's documented child-process contract: on 'close' exactly one of
 * (code, signal) is non-null. The signal case is dispatched before this call,
 * so reaching it with a null code means the runtime broke that contract and
 * the outcome below cannot be formed at all.
 */
function assertExitedWithCode (code: number|null, signal: NodeJS.Signals|null): asserts code is number {
  if (code === null) {
    throw new Error(
      'tikz-render: the pandoc child process closed carrying neither an exit code nor a signal ' +
      `(code=${String(code)}, signal=${String(signal)}). Node's child_process 'close' event ` +
      'guarantees exactly one of the two is non-null; the outcome handling in ' +
      'source/app/util/tikz-render.ts is written against that guarantee.'
    )
  }
}

/**
 * Renders one TikZ figure to inline SVG through the vendored pandoc filter.
 */
export async function renderTikz (request: TikzRenderRequest, config: TikzRenderConfig): Promise<TikzRenderResult> {
  const env = config.env ?? process.env

  const missing: string[] = []
  for (const tool of REQUIRED_TOOLS) {
    if (!await toolAvailable(tool, env)) {
      missing.push(tool)
    }
  }
  if (missing.length > 0) {
    return { ok: false, kind: 'missing-tools', missing }
  }

  await mkdir(config.cacheDir, { recursive: true })

  // pandoc's markdown reader classifies a \begin{…} block as RawBlock latex
  // and a ```tikz fence as CodeBlock tikz — exactly the two surfaces the
  // filter handles.
  const markdown = request.kind === 'raw'
    ? `${request.source}\n`
    : `\`\`\`tikz\n${request.source}\n\`\`\`\n`

  const filterPath = path.join(config.tikzAssetDir, 'filters/tikzcd.lua')
  const renderEnv: NodeJS.ProcessEnv = {
    ...env,
    PANDOC_DIR: config.tikzAssetDir,
    FIGURE_TEMPLATE_FILE: path.join(config.tikzAssetDir, 'templates/standalone-tikz.tex'),
    SVG_DIR: config.cacheDir,
    FIGURES_DIR: config.cacheDir,
    PANDOC_DOC_PATH: request.docPath,
  }

  const outcome = await new Promise<PandocProcessOutcome>((resolve, reject) => {
    const proc = spawn('pandoc', [ '-f', 'markdown', '-t', 'html', '--lua-filter', filterPath ], { env: renderEnv })
    let out = ''
    let err = ''
    proc.stdout.on('data', chunk => { out += String(chunk) })
    proc.stderr.on('data', chunk => { err += String(chunk) })
    proc.once('error', reject)
    proc.once('close', (exitCode, signal) => {
      if (signal !== null) {
        resolve({ ended: 'signal', signal, stdout: out, stderr: err })
        return
      }
      assertExitedWithCode(exitCode, signal)
      resolve({ ended: 'exit', code: exitCode, stdout: out, stderr: err })
    })
    proc.stdin.end(markdown)
  })

  if (outcome.ended === 'signal') {
    // The render never ran to completion, so whatever landed on stderr is a
    // partial transcript, not a diagnostic about the figure. Reporting the
    // signal keeps a kill distinguishable from pandoc failing on its own.
    return { ok: false, kind: 'render-terminated', signal: outcome.signal, log: outcome.stderr }
  }

  const errors: TikzCompileError[] = []
  for (const line of outcome.stderr.split('\n')) {
    const match = ERROR_MARKER_RE.exec(line)
    if (match !== null) {
      errors.push({ line: Number(match[1]), message: match[2], sourceLine: match[3] })
    }
  }

  if (errors.length > 0) {
    return { ok: false, kind: 'compile-error', errors, log: outcome.stderr }
  }

  if (outcome.code !== 0) {
    return { ok: false, kind: 'pandoc-error', log: outcome.stderr }
  }

  const svgMarkup = outcome.stdout.match(/<svg[\s\S]*?<\/svg>/)?.[0]
  if (svgMarkup === undefined) {
    // The HTML writer omitted the figure: the filter dropped a block that did
    // not compile without a bang-error block to cite (or produced no SVG).
    return { ok: false, kind: 'compile-error', errors: [], log: outcome.stderr }
  }

  // The filter caches by an internal template-folded hash; the lightbox file
  // is addressed by the request itself so the widget can open it by path.
  const requestHash = createHash('sha1').update(`${request.kind}\0${request.source}`).digest('hex')
  const svgPath = path.join(config.cacheDir, `lightbox-${requestHash}.svg`)
  await writeFile(svgPath, `<?xml version="1.0" encoding="UTF-8"?>\n${svgMarkup}\n`)

  // Reaching here means the pandoc output carries an <svg>…</svg>: that is the
  // guarantee consumers of an ok result are entitled to assume of `html`.
  return { ok: true, html: outcome.stdout, svgPath }
}
