#!/usr/bin/env node
/**
 * Reconstruct the forked Quiver vendor from its pinned upstream commit.
 *
 * This is deliberately a networked maintenance command, never part of the
 * ordinary test/build path. The checked-in vendor remains sufficient for all
 * builds. Changing the upstream commit is a patch-rebase operation: update
 * PROVENANCE.toml, rebase ZETTLR.patch, then run this script.
 */

import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vendor = path.join(root, 'vendor', 'quiver')

function provenanceValue (text, key) {
  const match = new RegExp(`^${key}\\s*=\\s*"([^"]+)"$`, 'm').exec(text)
  if (match === null) {
    throw new Error(`vendor/quiver/PROVENANCE.toml does not declare ${key}`)
  }
  return match[1]
}

async function fetchBytes (url) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Fetching ${url} failed with HTTP ${response.status}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

const provenance = await readFile(path.join(vendor, 'PROVENANCE.toml'), 'utf8')
const repository = provenanceValue(provenance, 'upstream_repository')
const commit = provenanceValue(provenance, 'upstream_commit')
const patchName = provenanceValue(provenance, 'patch_file')
const katexVersion = provenanceValue(provenance, 'katex_version')
const katexLicenseName = provenanceValue(provenance, 'katex_license_file')

if (!/^[0-9a-f]{40}$/u.test(commit)) {
  throw new Error(`Pinned Quiver commit is not a full Git object id: ${commit}`)
}

const temporary = await mkdtemp(path.join(os.tmpdir(), 'zettlr-quiver-vendor-'))
try {
  const upstream = path.join(temporary, 'upstream')
  execFileSync('git', [ 'clone', '--quiet', '--no-checkout', repository, upstream ], { stdio: 'inherit' })
  execFileSync('git', [ '-C', upstream, 'checkout', '--quiet', '--detach', commit ], { stdio: 'inherit' })
  const observed = execFileSync('git', [ '-C', upstream, 'rev-parse', 'HEAD' ], { encoding: 'utf8' }).trim()
  if (observed !== commit) {
    throw new Error(`Quiver checkout drifted: expected ${commit}, observed ${observed}`)
  }

  execFileSync('git', [ '-C', upstream, 'apply', '--check', path.join(vendor, patchName) ], { stdio: 'inherit' })
  execFileSync('git', [ '-C', upstream, 'apply', path.join(vendor, patchName) ], { stdio: 'inherit' })

  const stagedSource = path.join(temporary, 'src')
  await cp(path.join(upstream, 'src'), stagedSource, { recursive: true })

  // The public website uses generated/service-worker assets that Zettlr's local
  // iframe neither loads nor owns. Keep the vendor to source/editor assets.
  for (const relative of [
    'KaTeX', 'Workbox', 'service-worker.js', 'icon-192.png', 'icon-512.png'
  ]) {
    await rm(path.join(stagedSource, relative), { recursive: true, force: true })
  }

  const katexZip = path.join(temporary, 'katex.zip')
  await writeFile(
    katexZip,
    await fetchBytes(`https://github.com/KaTeX/KaTeX/releases/download/v${katexVersion}/katex.zip`)
  )
  execFileSync('unzip', [ '-q', katexZip, '-d', temporary ], { stdio: 'inherit' })
  const extractedKatex = path.join(temporary, 'katex')
  await rename(extractedKatex, path.join(stagedSource, 'KaTeX'))

  const katexLicense = await fetchBytes(
    `https://raw.githubusercontent.com/KaTeX/KaTeX/v${katexVersion}/LICENSE`
  )

  // Replace only the owned vendor subtree. The patch/provenance/maintenance
  // files live alongside it and are never regenerated from upstream.
  await rm(path.join(vendor, 'src'), { recursive: true, force: true })
  await rename(stagedSource, path.join(vendor, 'src'))
  await cp(path.join(upstream, 'LICENSE'), path.join(vendor, 'LICENSE'))
  await writeFile(path.join(vendor, katexLicenseName), katexLicense)

  console.log(`Rebuilt vendor/quiver from ${commit} with KaTeX ${katexVersion}`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
