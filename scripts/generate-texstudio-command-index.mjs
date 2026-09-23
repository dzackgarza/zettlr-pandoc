import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const TEXSTUDIO_COMMIT = '263f2615005cdbe5c24d4ee9a7c5746f731e25ac'
const BASELINE = [ 'tex', 'latex-document', 'latex-dev' ]

const inputDirectory = process.argv[2]
const outputFile = process.argv[3] ?? path.resolve('source/common/data/texstudio-command-index.json')

if (inputDirectory === undefined) {
  console.error('Usage: node scripts/generate-texstudio-command-index.mjs <texstudio-completion-dir> [output-json]')
  process.exit(2)
}

const cwlFiles = fs.readdirSync(inputDirectory)
  .filter(filename => filename.endsWith('.cwl'))
  .sort()

if (cwlFiles.length === 0) {
  throw new Error(`No .cwl files found in ${inputDirectory}`)
}

for (const packageName of [ ...BASELINE, 'mathtools', 'amsmath', 'amsopn' ]) {
  if (!cwlFiles.includes(`${packageName}.cwl`)) {
    throw new Error(`Required TeXstudio completion file is missing: ${packageName}.cwl`)
  }
}

const packages = {}
const sourceDigest = crypto.createHash('sha256')

function commandName (line) {
  if (line.charCodeAt(0) !== 92) {
    return undefined
  }
  return /^\\(?:[A-Za-z@]+|.)/u.exec(line)?.[0]
}

for (const filename of cwlFiles) {
  const packageName = filename.slice(0, -4)
  const contents = fs.readFileSync(path.join(inputDirectory, filename), 'utf8')
  sourceDigest.update(filename)
  sourceDigest.update('\0')
  sourceDigest.update(contents)
  sourceDigest.update('\0')

  const includes = new Set()
  const commands = new Set()
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line.startsWith('#include:')) {
      const dependency = line.slice('#include:'.length).trim()
      if (dependency !== '') {
        includes.add(dependency)
      }
      continue
    }
    const command = commandName(line)
    if (command !== undefined) {
      commands.add(command)
    }
  }

  packages[packageName] = {
    i: [...includes].sort(),
    c: [...commands].sort()
  }
}

const index = {
  v: 1,
  source: {
    repository: 'https://github.com/texstudio-org/texstudio',
    commit: TEXSTUDIO_COMMIT,
    completionTreeSha256: sourceDigest.digest('hex'),
    cwlFiles: cwlFiles.length
  },
  b: BASELINE,
  p: packages
}

fs.mkdirSync(path.dirname(outputFile), { recursive: true })
fs.writeFileSync(outputFile, JSON.stringify(index))
console.log(`Wrote ${Object.keys(packages).length} CWL providers to ${outputFile}`)
