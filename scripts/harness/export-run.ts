/**
 * Headless app-level export harness.
 *
 * Runs the LITERAL command the GUI runs on export — the real makeExport — with
 * no window, so exports can be exercised from the terminal. Crucially it builds
 * the export-profile list EXACTLY like the `list-export-profiles` IPC does
 * (userData/defaults + getCustomProfiles), so it sees the same profiles (and the
 * same stale/duplicate ones) the running app sees — not a hand-picked subset.
 *
 * Usage (via the electron shim preload):
 *   node --require ./scripts/harness/electron-stub.cjs --import tsx \
 *        ./scripts/harness/export-run.ts <ProfileName.yaml> <source.md> [targetDir]
 *
 * Or `just export-headless <ProfileName.yaml> <source.md>`.
 */
import { makeExport, getCustomProfiles } from '../../source/app/service-providers/commands/exporter/index'
import { promises as fs, readFileSync } from 'fs'
import path from 'path'
import os from 'os'
import YAML from 'yaml'

async function main (): Promise<void> {
  const [ profileName, sourceFile, targetDir = '/tmp/zp-harness-out' ] = process.argv.slice(2)
  if (profileName === undefined || sourceFile === undefined) {
    console.error('usage: export-run <ProfileName.yaml> <source.md> [targetDir]')
    process.exit(2)
  }

  const userData = path.join(os.homedir(), '.config', 'Zettlr-Pandoc')
  const appConfig = JSON.parse(readFileSync(path.join(userData, 'config.json'), 'utf8'))
  const defaultsDir = path.join(userData, 'defaults')

  // Reproduce `list-export-profiles`: defaults from userData + custom profiles.
  const files = (await fs.readdir(defaultsDir)).filter(f => f.endsWith('.yaml'))
  const defaultsProfiles = files.map(f => {
    const parsed = YAML.parse(readFileSync(path.join(defaultsDir, f), 'utf8'))
    return { name: f, reader: parsed.reader, writer: parsed.writer, isInvalid: false }
  })
  const allProfiles = [ ...defaultsProfiles, ...getCustomProfiles(appConfig.export.scripts) ]

  const byName: Record<string, string[]> = {}
  for (const p of allProfiles) { (byName[p.name] ??= []).push(p.writer) }
  console.log('=== profiles the GUI lists (name -> writer) ===')
  for (const [ name, writers ] of Object.entries(byName)) {
    const dup = writers.length > 1 ? '   <<< DUPLICATE NAME' : ''
    console.log(`  ${name}: ${writers.join(', ')}${dup}`)
  }

  const profile = allProfiles.find(p => p.name === profileName)
  if (profile === undefined) {
    console.error(`\nprofile ${profileName} not found in the list above`)
    process.exit(2)
  }
  console.log(`\n=== makeExport: ${profile.name} (writer=${profile.writer}) ===`)

  await fs.mkdir(targetDir, { recursive: true })
  const config: any = { get: () => appConfig }
  const assets: any = {
    getDefaultsFile: async (filename: string) => YAML.parse(readFileSync(path.join(defaultsDir, filename), 'utf8')),
    listDefaults: async () => defaultsProfiles
  }
  const log: any = { info () {}, error () {}, verbose () {}, warning () {} }
  const options: any = {
    profile,
    targetDirectory: targetDir,
    sourceFiles: [ { path: sourceFile, name: path.basename(sourceFile), ext: path.extname(sourceFile) } ],
    cwd: path.dirname(sourceFile)
  }

  const out = await makeExport(options, log, config, assets)
  console.log('EXIT', out.code, 'TARGET', out.targetFile)
  console.log('STDERR TAIL:', out.stderr.slice(-2).join(' | '))
}

main().catch(e => { console.error('HARNESS ERROR:', e instanceof Error ? e.message : e); process.exit(1) })
