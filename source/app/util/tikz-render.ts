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
 *                  missing tools and compile failures are loud, never silence.
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
  /** The document the figure was authored in, for \input resolution. */
  docPath?: string
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
  { ok: false, kind: 'pandoc-error', log: string }

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
    const probe = spawn(tool, [ '--version' ], { env, stdio: 'ignore' })
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
    PANDOC_DOC_PATH: request.docPath ?? '',
  }

  const { code, stdout, stderr } = await new Promise<{ code: number, stdout: string, stderr: string }>((resolve, reject) => {
    const proc = spawn('pandoc', [ '-f', 'markdown', '-t', 'html', '--lua-filter', filterPath ], { env: renderEnv })
    let out = ''
    let err = ''
    proc.stdout.on('data', chunk => { out += String(chunk) })
    proc.stderr.on('data', chunk => { err += String(chunk) })
    proc.once('error', reject)
    proc.once('close', exitCode => resolve({ code: exitCode ?? -1, stdout: out, stderr: err }))
    proc.stdin.end(markdown)
  })

  const errors: TikzCompileError[] = []
  for (const line of stderr.split('\n')) {
    const match = ERROR_MARKER_RE.exec(line)
    if (match !== null) {
      errors.push({ line: Number(match[1]), message: match[2], sourceLine: match[3] })
    }
  }

  if (errors.length > 0) {
    return { ok: false, kind: 'compile-error', errors, log: stderr }
  }

  if (code !== 0) {
    return { ok: false, kind: 'pandoc-error', log: stderr }
  }

  const svgMarkup = stdout.match(/<svg[\s\S]*?<\/svg>/)?.[0]
  if (svgMarkup === undefined) {
    // The HTML writer omitted the figure: the filter dropped a block that did
    // not compile without a bang-error block to cite (or produced no SVG).
    return { ok: false, kind: 'compile-error', errors: [], log: stderr }
  }

  // The filter caches by an internal template-folded hash; the lightbox file
  // is addressed by the request itself so the widget can open it by path.
  const requestHash = createHash('sha1').update(`${request.kind}\0${request.source}`).digest('hex')
  const svgPath = path.join(config.cacheDir, `lightbox-${requestHash}.svg`)
  await writeFile(svgPath, `<?xml version="1.0" encoding="UTF-8"?>\n${svgMarkup}\n`)

  return { ok: true, html: stdout, svgPath }
}
