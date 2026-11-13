/**
 * Headless app-level export harness.
 *
 * Runs the LITERAL command the GUI runs on export — the real makeExport — with
 * no window, so exports can be exercised from the terminal. It builds the
 * export-profile list with `exportProfiles`, the function of the
 * `list-export-profiles` IPC and of the Project export, so it sees the profiles
 * that the running app sees.
 *
 * Usage (via the electron shim preload):
 *   node --require ./scripts/harness/electron-stub.cjs --import tsx \
 *        ./scripts/harness/export-run.ts <ProfileName.yaml> <source.md> [targetDir]
 *
 * Or `just export-headless <ProfileName.yaml> <source.md>`.
 */
import { makeExport, exportProfiles } from '../../source/app/service-providers/commands/exporter/index'
import { promises as fs, readFileSync } from 'fs'
import path from 'path'
import os from 'os'
import YAML from 'yaml'
import { WikilinkIndex } from '../../source/common/util/wikilink-resolution'
import { hasMarkdownExt } from '../../source/common/util/file-extention-checks'
import { parse as parseDirectory } from '../../source/app/service-providers/fsal/fsal-directory'
import { copyExportMathJax } from '../export-mathjax.js'

function stderr (message: string): void {
  process.stderr.write(`${message}\n`)
}

/**
 * The wikilink index of the open workspace that contains `sourceFile`. The
 * app builds its index from the FSAL's parsed descriptors, which need the
 * whole app; the harness knows the paths only, so links by ID, alias or title
 * stay unresolved here.
 */
async function workspaceIndex (sourceFile: string, appConfig: any): Promise<WikilinkIndex> {
  const root: string = [...appConfig.app.openWorkspaces as string[]]
    .sort((a, b) => b.length - a.length)
    .find(workspace => sourceFile.startsWith(workspace + path.sep)) ?? path.dirname(sourceFile)
  const entries = await fs.readdir(root, { recursive: true })
  return new WikilinkIndex(entries
    .filter(entry => hasMarkdownExt(entry) && !entry.split(path.sep).some(segment => segment.startsWith('.')))
    .map(entry => ({ path: path.join(root, entry), root, id: '', title: undefined, aliases: [] })))
}

async function main (): Promise<void> {
  const [ profileName, sourceFile, targetDir = '/tmp/zp-harness-out' ] = process.argv.slice(2)
  if (profileName === undefined || sourceFile === undefined) {
    stderr('usage: export-run <ProfileName.yaml> <source.md> [targetDir]')
    process.exit(2)
  }

  const userData = path.join(os.homedir(), '.config', 'Zettlr-Pandoc')
  const appConfig = JSON.parse(readFileSync(path.join(userData, 'config.json'), 'utf8'))
  const defaultsDir = path.join(userData, 'defaults')

  // The defaults files of userData, as `listDefaults` reads them.
  const files = (await fs.readdir(defaultsDir)).filter(f => f.endsWith('.yaml'))
  const defaultsProfiles = files.map(f => {
    const parsed = YAML.parse(readFileSync(path.join(defaultsDir, f), 'utf8'))
    return { name: f, reader: parsed.reader, writer: parsed.writer, isInvalid: false as const }
  })
  const allProfiles = exportProfiles(defaultsProfiles, appConfig.export.scripts)

  console.log('=== profiles the GUI lists (name -> writer) ===')
  for (const p of allProfiles) { console.log(`  ${p.name}: ${p.writer}`) }

  const profile = allProfiles.find(p => p.name === profileName)
  if (profile === undefined) {
    stderr(`\nprofile ${profileName} not found in the list above`)
    process.exit(2)
  }
  console.log(`\n=== makeExport: ${profile.name} (writer=${profile.writer}) ===`)

  await fs.mkdir(targetDir, { recursive: true })
  const config: any = { get: () => appConfig }
  // An exported HTML file loads its MathJax from this folder, so it stays
  // beside the output.
  const exportMathJaxDirectory = path.join(targetDir, 'mathjax')
  await copyExportMathJax(exportMathJaxDirectory)
  const assets: any = {
    exportMathJaxDirectory,
    getDefaultsFile: async (filename: string) => YAML.parse(readFileSync(path.join(defaultsDir, filename), 'utf8')),
    listDefaults: async () => defaultsProfiles
  }
  const log: any = { info () {}, error () {}, verbose () {}, warning () {} }
  const options: any = {
    profile,
    targetDirectory: targetDir,
    sourceFiles: [
      {
        path: sourceFile,
        name: path.basename(sourceFile),
        ext: path.extname(sourceFile),
        textFile: sourceFile,
      },
    ],
    cwd: path.dirname(sourceFile)
  }

  // The folders of the document are read from disk, as the FSAL reads them.
  const folders = { getAnyDirectoryDescriptor: async (dirPath: string) => await parseDirectory(dirPath) }
  const out = await makeExport(options, log, config, assets, await workspaceIndex(sourceFile, appConfig), folders)
  console.log('EXIT', out.code, 'TARGET', out.targetFile)
  console.log('STDERR TAIL:', out.stderr.slice(-2).join(' | '))
}

main().catch(e => { stderr(`HARNESS ERROR: ${e instanceof Error ? e.message : String(e)}`); process.exit(1) })
