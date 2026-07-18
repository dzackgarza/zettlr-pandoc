import assert from 'assert'
import { execFile } from 'child_process'
import { access, cp, mkdtemp, mkdir, readFile, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import YAML from 'yaml'
import { writeDefaults } from 'source/app/service-providers/commands/exporter/index'
import { composePdfOperationAndCleanup } from 'source/app/service-providers/commands/exporter/pdf-exporter'

const execFileAsync = promisify(execFile)

async function runElectronReadinessProbe (htmlFile: string): Promise<string> {
  const result = await execFileAsync(
    'xvfb-run',
    [ '-a', path.resolve('node_modules/.bin/electron'), path.resolve('test/pdf-exporter-boundary.cjs'), htmlFile ],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
    }
  )
  return result.stdout.trim()
}

async function runSimplePdfExport (defaultsFile: string, inputFile: string, targetDirectory: string): Promise<{ code: number, targetFile: string }> {
  const result = await execFileAsync(
    'xvfb-run',
    [ '-a', path.resolve('node_modules/.bin/electron'), path.resolve('test/pdf-exporter-plugin.cjs'), defaultsFile, inputFile, targetDirectory ],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
    }
  )
  const output = result.stdout.match(/ZETTLR_SIMPLE_PDF_RESULT=(.*)$/m)
  if (output === null) {
    throw new Error(`Simple PDF export result was not reported: ${result.stdout}`)
  }
  return JSON.parse(output[1]) as { code: number, targetFile: string }
}

async function runMissingMathJaxExport (defaultsFile: string, inputFile: string, targetDirectory: string): Promise<{ windows: number }> {
  let failure: (NodeJS.ErrnoException & { code?: number, stdout: string }) | undefined
  await assert.rejects(
    execFileAsync(
      'xvfb-run',
      [ '-a', path.resolve('node_modules/.bin/electron'), path.resolve('test/pdf-exporter-readiness-failure.cjs'), defaultsFile, inputFile, targetDirectory ],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
      }
    ),
    (error: NodeJS.ErrnoException & { code?: number, stdout: string }) => {
      failure = error
      return error.code === 1
    }
  )
  if (failure === undefined) {
    throw new Error('Missing expected Simple PDF failure')
  }
  return JSON.parse(failure.stdout) as { windows: number }
}

describe('Simple PDF MathJax readiness', function () {
  // A fresh Electron renderer exceeds Mocha's default two-second test budget.
  this.timeout(30_000)

  it('loads actual Simple PDF HTML through BrowserWindow before proving MathJax and fonts are ready', async function () {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zettlr-simple-pdf-'))
    const inputFile = path.join(directory, 'input.md')
    const htmlFile = path.join(directory, 'output.html')
    const component = path.join(directory, 'assets', 'defaults', 'mathjax-tex-chtml.js')
    const extensions = path.join(directory, 'assets', 'defaults', 'mathjax-tex-extensions')
    const mhchemFontExtension = path.join(directory, 'assets', 'defaults', 'mathjax-mhchem-font-extension')
    const fontDirectory = path.join(directory, 'assets', 'defaults', 'mathjax-font')
    const speechRuleEngine = path.join(directory, 'assets', 'defaults', 'mathjax-sre')
    const defaults = YAML.parse(await readFile('static/defaults/HTML.yaml', { encoding: 'utf8' })) as Record<string, unknown>

    await writeFile(inputFile, '$\\RR$ and $\\ce{H2O}$\n')
    await mkdir(path.dirname(component), { recursive: true })
    await cp('node_modules/@mathjax/src/bundle/tex-chtml.js', component)
    await cp('node_modules/@mathjax/src/bundle/input/tex/extensions', extensions, { recursive: true })
    await cp('node_modules/@mathjax/mathjax-mhchem-font-extension', mhchemFontExtension, { recursive: true })
    await cp('node_modules/@mathjax/mathjax-newcm-font/chtml', fontDirectory, { recursive: true })
    await cp('node_modules/@mathjax/src/bundle/sre', speechRuleEngine, { recursive: true })

    const defaultsFile = await writeDefaults(
      defaults,
      {
        'input-files': [ inputFile ],
        'output-file': htmlFile,
        standalone: true
      },
      {
        export: {
          cslLibrary: '',
          cslStyle: '',
          stripTags: false,
          stripLinks: 'no',
          enforceMarkSupport: false
        },
        zkn: { linkFormat: 'link|title' }
      },
      [],
      directory,
      component
    )

    await execFileAsync('pandoc', [ '--defaults', defaultsFile ])
    assert.strictEqual(await runElectronReadinessProbe(htmlFile), 'mathjax-and-fonts-ready')
  })

  it('prints rendered macro and chemistry output through the Simple PDF plugin', async function () {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zettlr-simple-pdf-output-'))
    const inputFile = path.join(directory, 'input.md')
    const pdfTextFile = path.join(directory, 'output.txt')
    const pdfImage = path.join(directory, 'output.png')
    const component = path.join(directory, 'assets', 'defaults', 'mathjax-tex-chtml.js')
    const extensions = path.join(directory, 'assets', 'defaults', 'mathjax-tex-extensions')
    const mhchemFontExtension = path.join(directory, 'assets', 'defaults', 'mathjax-mhchem-font-extension')
    const fontDirectory = path.join(directory, 'assets', 'defaults', 'mathjax-font')
    const speechRuleEngine = path.join(directory, 'assets', 'defaults', 'mathjax-sre')

    await mkdir(path.dirname(component), { recursive: true })
    await cp('node_modules/@mathjax/src/bundle/tex-chtml.js', component)
    await cp('node_modules/@mathjax/src/bundle/input/tex/extensions', extensions, { recursive: true })
    await cp('node_modules/@mathjax/mathjax-mhchem-font-extension', mhchemFontExtension, { recursive: true })
    await cp('node_modules/@mathjax/mathjax-newcm-font/chtml', fontDirectory, { recursive: true })
    await cp('node_modules/@mathjax/src/bundle/sre', speechRuleEngine, { recursive: true })
    await writeFile(inputFile, '$\\RR$ and $\\ce{H2O}$\n')

    const defaultsFile = await writeDefaults(
      YAML.parse(await readFile('static/defaults/HTML.yaml', { encoding: 'utf8' })),
      {
        'input-files': [ inputFile ],
        'output-file': path.join(directory, 'input.html'),
        standalone: true
      },
      {
        export: {
          cslLibrary: '',
          cslStyle: '',
          stripTags: false,
          stripLinks: 'no',
          enforceMarkSupport: false
        },
        zkn: { linkFormat: 'link|title' }
      },
      [],
      directory,
      component
    )

    const output = await runSimplePdfExport(defaultsFile, inputFile, directory)
    await execFileAsync('pdftotext', [ output.targetFile, pdfTextFile ])
    await execFileAsync('pdftoppm', [ '-f', '1', '-l', '1', '-png', '-singlefile', output.targetFile, pdfImage.slice(0, -4) ])

    const pdfText = await readFile(pdfTextFile, { encoding: 'utf8' })
    assert.strictEqual(output.code, 0)
    assert.ok(!pdfText.includes('\\RR'))
    assert.ok(!pdfText.includes('\\ce{H2O}'))
    assert.match(pdfText, /ℝ/)
    assert.match(pdfText, /H\s*2\s*O/)
  })

  it('preserves all operation and cleanup outcomes', async function () {
    const pdfData = Buffer.from('pdf')
    const operationError = new TypeError()
    const cleanupError = new RangeError()

    assert.strictEqual(
      await composePdfOperationAndCleanup(Promise.resolve(pdfData), Promise.resolve()),
      pdfData
    )
    await assert.rejects(
      composePdfOperationAndCleanup(Promise.reject(operationError), Promise.resolve()),
      error => error === operationError
    )
    await assert.rejects(
      composePdfOperationAndCleanup(Promise.resolve(pdfData), Promise.reject(cleanupError)),
      error => error === cleanupError
    )
    await assert.rejects(
      composePdfOperationAndCleanup(Promise.reject(operationError), Promise.reject(cleanupError)),
      (error: unknown) => error instanceof AggregateError && error.errors[0] === operationError && error.errors[1] === cleanupError
    )
  })

  it('closes the hidden BrowserWindow when MathJax is unavailable', async function () {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zettlr-simple-pdf-missing-mathjax-'))
    const inputFile = path.join(directory, 'input.md')
    const htmlFile = path.join(directory, 'input.html')
    const defaultsFile = path.join(directory, 'defaults.yml')

    await writeFile(inputFile, '$x$\n')
    await writeFile(defaultsFile, YAML.stringify({
      reader: 'markdown',
      writer: 'html',
      standalone: true,
      'input-files': [ inputFile ],
      'output-file': htmlFile
    }))

    assert.deepStrictEqual(await runMissingMathJaxExport(defaultsFile, inputFile, directory), { windows: 0 })
    await assert.rejects(access(htmlFile))
  })
})
