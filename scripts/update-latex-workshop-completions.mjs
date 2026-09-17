#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.join(root, 'static', 'autocomplete')
const repository = 'https://github.com/James-Yu/LaTeX-Workshop.git'
const commit = execFileSync('git', ['ls-remote', repository, 'HEAD'], { encoding: 'utf8' })
  .trim()
  .split(/\s+/u)[0]

if (!/^[0-9a-f]{40}$/u.test(commit)) {
  throw new Error(`Could not resolve LaTeX Workshop HEAD: ${commit}`)
}

async function fetchText (relativePath) {
  const url = `https://raw.githubusercontent.com/James-Yu/LaTeX-Workshop/${commit}/${relativePath}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Fetching ${url} failed with HTTP ${response.status}`)
  }
  return await response.text()
}

await mkdir(outputDir, { recursive: true })
const commands = await fetchText('data/commands.json')
JSON.parse(commands) // refuse to bank a broken upstream response
await writeFile(path.join(outputDir, 'latex-workshop-commands.json'), commands, 'utf8')
const environments = await fetchText('data/environments.json')
JSON.parse(environments)
await writeFile(path.join(outputDir, 'latex-workshop-environments.json'), environments, 'utf8')
await writeFile(path.join(outputDir, 'LATEX-WORKSHOP-LICENSE.txt'), await fetchText('LICENSE.txt'), 'utf8')
await writeFile(
  path.join(outputDir, 'PROVENANCE.toml'),
  `schema = 1\n` +
  `source_repository = "https://github.com/James-Yu/LaTeX-Workshop"\n` +
  `source_files = ["data/commands.json", "data/environments.json"]\n` +
  `source_commit = "${commit}"\n` +
  `license = "MIT"\n` +
  `license_file = "LATEX-WORKSHOP-LICENSE.txt"\n` +
  `purpose = "Maintained standard LaTeX command/snippet and environment catalogues for editor completion"\n\n` +
  `[maintenance]\n` +
  `update = "node scripts/update-latex-workshop-completions.mjs"\n` +
  `note = "Do not hand-edit the LaTeX Workshop JSON snapshots; regenerate them from upstream."\n`,
  'utf8'
)

console.log(`Updated LaTeX Workshop completion data from ${commit}`)
