#!/usr/bin/env node
/** Reconstruct the vendored tikz-editor embed from its pinned upstream commit. */

import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vendor = path.join(root, 'vendor', 'tikz-editor')

function provenanceValue (text, key) {
  const match = new RegExp(`^${key}\\s*=\\s*"([^"]+)"$`, 'm').exec(text)
  if (match === null) throw new Error(`vendor/tikz-editor/PROVENANCE.toml does not declare ${key}`)
  return match[1]
}

function run (command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit', env: process.env })
}

const provenance = await readFile(path.join(vendor, 'PROVENANCE.toml'), 'utf8')
const repository = provenanceValue(provenance, 'upstream_repository')
const commit = provenanceValue(provenance, 'upstream_commit')
if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`Pinned tikz-editor commit is not a full Git object id: ${commit}`)

const temporary = await mkdtemp(path.join(os.tmpdir(), 'zettlr-tikz-editor-vendor-'))
try {
  const repositoryClone = path.join(temporary, 'repository')
  const upstream = path.join(temporary, 'upstream')
  run('git', [ 'clone', '--quiet', '--no-checkout', repository, repositoryClone ], root)
  run('git', [ '-C', repositoryClone, 'worktree', 'add', '--quiet', '--detach', upstream, commit ], root)
  const observed = execFileSync('git', [ '-C', upstream, 'rev-parse', 'HEAD' ], { encoding: 'utf8' }).trim()
  if (observed !== commit) throw new Error(`tikz-editor checkout drifted: expected ${commit}, observed ${observed}`)
  run('git', [ '-C', upstream, 'apply', '--check', path.join(vendor, 'ZETTLR.patch') ], root)
  run('git', [ '-C', upstream, 'apply', path.join(vendor, 'ZETTLR.patch') ], root)

  const embedApp = path.join(upstream, 'apps', 'zettlr-embed')
  await cp(path.join(vendor, 'embed'), embedApp, { recursive: true })
  await writeFile(
    path.join(embedApp, 'index.html'),
    '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>TikZ Editor</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n'
  )

  run('bun', [ 'install', '--no-save' ], upstream)
  run('bunx', [ 'lezer-generator', '--typeScript', 'src/grammar/tikz.grammar', '-o', 'src/grammar/tikz-parser.ts' ], path.join(upstream, 'packages/lezer-tikz'))
  for (const name of [ 'lezer-tikz', 'lang-tikz', 'core' ]) {
    run('bunx', [ 'tsc', '-p', path.join(upstream, `packages/${name}/tsconfig.json`) ], upstream)
  }
  run('bun', [ 'run', 'build' ], embedApp)

  const staged = path.join(temporary, 'src')
  await cp(path.join(embedApp, 'dist'), staged, { recursive: true })

  // tikz-editor's browser text engine normally bootstraps MathJax from a CDN.
  // The Zettlr fork points that loader at ./mathjax instead, so ship the exact
  // component package selected by the pinned upstream lockfile. The default
  // NewCM SVG font lives under MathJax's expected output/fonts component path.
  const mathjax = path.join(upstream, 'node_modules', 'mathjax')
  const newcm = path.join(upstream, 'node_modules', '@mathjax', 'mathjax-newcm-font')
  const mathjaxPackage = JSON.parse(await readFile(path.join(mathjax, 'package.json'), 'utf8'))
  const newcmPackage = JSON.parse(await readFile(path.join(newcm, 'package.json'), 'utf8'))
  if (mathjaxPackage.version !== '4.1.1' || newcmPackage.version !== '4.1.1') {
    throw new Error(
      `Unexpected MathJax runtime versions: mathjax=${mathjaxPackage.version}, ` +
      `mathjax-newcm-font=${newcmPackage.version}`
    )
  }
  await cp(mathjax, path.join(staged, 'mathjax'), { recursive: true })
  const fontTarget = path.join(staged, 'mathjax', 'output', 'fonts', 'mathjax-newcm-font')
  await cp(path.join(newcm, 'svg.js'), path.join(fontTarget, 'svg.js'))
  await cp(path.join(newcm, 'svg'), path.join(fontTarget, 'svg'), { recursive: true })

  run('trash', [ path.join(vendor, 'src') ], root)
  await cp(staged, path.join(vendor, 'src'), { recursive: true })
  await cp(path.join(upstream, 'LICENSE'), path.join(vendor, 'LICENSE'))
  await cp(path.join(mathjax, 'LICENSE'), path.join(vendor, 'MATHJAX-LICENSE.txt'))
  // The NewCM npm package declares Apache-2.0 but does not ship a separate
  // LICENSE file; retain the same Apache-2.0 text beside the vendored assets.
  await cp(path.join(mathjax, 'LICENSE'), path.join(vendor, 'MATHJAX-NEWCM-LICENSE.txt'))
  console.log(`Rebuilt vendor/tikz-editor from ${commit}`)
} finally {
  run('trash', [ temporary ], root)
}
