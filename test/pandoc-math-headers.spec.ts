import assert from 'assert'
import { execFile } from 'child_process'
import { mkdtemp, readFile, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { injectPandocMathHeaders } from 'source/app/service-providers/commands/exporter/pandoc-math-headers'

const execFileAsync = promisify(execFile)

async function runPandoc (defaultsFile: string): Promise<string> {
  await execFileAsync('pandoc', [ '--defaults', defaultsFile ])
  const defaults = await readFile(defaultsFile, { encoding: 'utf8' })
  const outputFile = defaults.match(/^output-file: (.+)$/m)?.[1]
  if (outputFile === undefined) {
    throw new Error('Pandoc defaults did not specify an output file')
  }
  return await readFile(outputFile, { encoding: 'utf8' })
}

describe('Pandoc math export headers', function () {
  it('runs real Pandoc HTML with macro config before the local MathJax component', async function () {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zettlr-pandoc-html-'))
    const inputFile = path.join(directory, 'input.md')
    const outputFile = path.join(directory, 'output.html')
    const defaultsFile = path.join(directory, 'defaults.yaml')
    const existingHeader = path.join(directory, 'existing.html')
    const component = path.join(directory, 'mathjax', 'tex-chtml.js')
    const defaults: Record<string, unknown> = {
      from: 'markdown',
      to: 'html',
      standalone: true,
      'input-files': [ inputFile ],
      'output-file': outputFile,
      'include-in-header': [ existingHeader ]
    }

    await writeFile(inputFile, '$\\RR$ and $\\ce{H2O}$\n')
    await writeFile(existingHeader, '<meta name="preserved-header" content="yes">')
    await injectPandocMathHeaders(defaults, 'html', directory, component)
    await writeFile(defaultsFile, Object.entries(defaults).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n'))

    const html = await runPandoc(defaultsFile)
    const configHeader = (defaults['include-in-header'] as string[])[0]
    const config = await readFile(configHeader, { encoding: 'utf8' })

    assert.match(config, /"RR": "\\\\mathbb\{R\}"/)
    assert.match(config, /"mhchem"/)
    assert.match(config, /"fontURL": "file:\/\//)
    assert.ok(html.indexOf('window.MathJax') < html.indexOf('tex-chtml.js'))
    assert.ok(html.includes('preserved-header'))
    assert.ok(html.includes('file:///'))
  })

  it('runs real Pandoc TeX with projected macros while preserving existing headers', async function () {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zettlr-pandoc-tex-'))
    const inputFile = path.join(directory, 'input.md')
    const outputFile = path.join(directory, 'output.tex')
    const defaultsFile = path.join(directory, 'defaults.yaml')
    const existingHeader = path.join(directory, 'existing.tex')
    const defaults: Record<string, unknown> = {
      from: 'markdown',
      to: 'latex',
      standalone: true,
      'input-files': [ inputFile ],
      'output-file': outputFile,
      'include-in-header': [ existingHeader ]
    }

    await writeFile(inputFile, '$\\RR$ and $\\ce{H2O}$\n')
    await writeFile(existingHeader, '\\newcommand{\\Preserved}{yes}')
    await injectPandocMathHeaders(defaults, 'latex', directory, path.join(directory, 'unused.js'))
    await writeFile(defaultsFile, Object.entries(defaults).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n'))

    const tex = await runPandoc(defaultsFile)

    assert.match(tex, /\\usepackage\[version=4\]\{mhchem\}/)
    assert.match(tex, /\\newcommand\{\\RR\}\{\\mathbb\{R\}\}/)
    assert.match(tex, /\\newcommand\{\\Preserved\}\{yes\}/)
  })
})
