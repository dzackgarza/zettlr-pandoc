import assert from 'assert'
import { execFile } from 'child_process'
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import YAML from 'yaml'
import { writeDefaults } from 'source/app/service-providers/commands/exporter/index'

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

async function runMissingMathJaxExport (defaultsFile: string, inputFile: string, targetDirectory: string): Promise<string> {
  const result = await execFileAsync(
    'xvfb-run',
    [ '-a', path.resolve('node_modules/.bin/electron'), path.resolve('test/pdf-exporter-readiness-failure.cjs'), defaultsFile, inputFile, targetDirectory ],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
    }
  )
  return result.stdout.trim()
}

describe('Simple PDF MathJax readiness', function () {
  // A fresh Electron renderer exceeds Mocha's default two-second test budget.
  this.timeout(10_000)

  it('loads actual Simple PDF HTML through BrowserWindow before proving MathJax and fonts are ready', async function () {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zettlr-simple-pdf-'))
    const inputFile = path.join(directory, 'input.md')
    const htmlFile = path.join(directory, 'output.html')
    const component = path.join(directory, 'assets', 'defaults', 'mathjax-tex-chtml.js')
    const fontDirectory = path.join(directory, 'assets', 'defaults', 'mathjax-font')
    const defaults = YAML.parse(await readFile('static/defaults/HTML.yaml', { encoding: 'utf8' })) as Record<string, unknown>

    await writeFile(inputFile, '$\\RR$ and $\\ce{H2O}$\n')
    await mkdir(path.dirname(component), { recursive: true })
    await cp('node_modules/@mathjax/src/bundle/tex-chtml.js', component)
    await cp('node_modules/@mathjax/mathjax-newcm-font/chtml', fontDirectory, { recursive: true })

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

    assert.strictEqual(
      await runMissingMathJaxExport(defaultsFile, inputFile, directory),
      'Simple PDF MathJax runtime is unavailable:0'
    )
  })
})
