import assert from 'assert'
import { execFile } from 'child_process'
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'
import { promisify } from 'util'
import { runInNewContext } from 'vm'
import YAML from 'yaml'
import { writeDefaults } from 'source/app/service-providers/commands/exporter/index'
import { injectPandocMathHeaders } from 'source/app/service-providers/commands/exporter/pandoc-math-headers'

interface MathJaxWindow {
  MathJax?: {
    loader?: {
      load?: string[]
      paths?: Record<string, string>
    }
    tex?: {
      inlineMath?: Record<string, string[][]>
      macros?: Record<string, unknown>
      packages?: Record<string, string[]>
    }
    chtml?: {
      fontURL?: string
    }
  }
}

const execFileAsync = promisify(execFile)

async function runPandoc (defaultsFile: string, outputFile: string): Promise<string> {
  await execFileAsync('pandoc', [ '--defaults', defaultsFile ])
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
    const defaults = YAML.parse(await readFile('static/defaults/HTML.yaml', { encoding: 'utf8' })) as Record<string, unknown>
    defaults.standalone = true
    defaults['input-files'] = [ inputFile ]
    defaults['output-file'] = outputFile
    defaults['include-in-header'] = [ existingHeader ]

    await writeFile(inputFile, '$\\RR$ and $\\ce{H2O}$\n')
    await writeFile(existingHeader, '<meta name="preserved-header" content="yes">')
    await mkdir(path.dirname(component), { recursive: true })
    await cp('node_modules/@mathjax/src/bundle/tex-chtml.js', component)
    await injectPandocMathHeaders(defaults, directory, component)
    await writeFile(defaultsFile, Object.entries(defaults).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n'))

    const html = await runPandoc(defaultsFile, outputFile)
    const configHeader = (defaults['include-in-header'] as string[])[1]
    const config = await readFile(configHeader, { encoding: 'utf8' })
    const window: MathJaxWindow = {}
    for (const script of config.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      runInNewContext(script[1], { window })
    }

    assert.strictEqual(window.MathJax?.tex?.macros?.RR, '\\mathbb{R}')
    assert.deepStrictEqual(JSON.parse(JSON.stringify(window.MathJax?.tex?.inlineMath?.['[+]'])), [ [ '$', '$' ] ])
    assert.deepStrictEqual(Array.from(window.MathJax?.loader?.load ?? []), [ '[tex]/mhchem' ])
    assert.strictEqual(window.MathJax?.loader?.paths?.tex, `${pathToFileURL(path.join(path.dirname(component), 'mathjax-tex-extensions')).href}/`)
    assert.deepStrictEqual(Array.from(window.MathJax?.tex?.packages?.['[+]'] ?? []), [ 'ams', 'configmacros', 'mhchem', 'newcommand', 'noundefined' ])
    assert.match(window.MathJax?.chtml?.fontURL ?? '', /^file:\/\//)
    assert.match(config, /"RR": "\\\\mathbb\{R\}"/)
    assert.match(config, /"mhchem"/)
    assert.match(config, /"fontURL": "file:\/\//)
    assert.match(config, /<\/script>\n<script defer src="file:\/\/[^\"]+tex-chtml\.js">/)
    assert.ok(html.includes('preserved-header'))
    assert.ok(html.includes('file:///'))
  })

  it('renders canonical macros and mhchem in a local Chromium HTML export', async function () {
    this.timeout(12000)
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zettlr-pandoc-browser-'))
    const inputFile = path.join(directory, 'input.md')
    const outputFile = path.join(directory, 'output.html')
    const component = path.join(directory, 'assets', 'defaults', 'mathjax-tex-chtml.js')
    const extensions = path.join(directory, 'assets', 'defaults', 'mathjax-tex-extensions')
    const fontDirectory = path.join(directory, 'assets', 'defaults', 'mathjax-font')
    const screenshot = path.join(directory, 'render.png')

    await mkdir(path.dirname(component), { recursive: true })
    await cp('node_modules/@mathjax/src/bundle/tex-chtml.js', component)
    await cp('node_modules/@mathjax/src/bundle/input/tex/extensions', extensions, { recursive: true })
    await cp('node_modules/@mathjax/mathjax-newcm-font/chtml', fontDirectory, { recursive: true })
    await writeFile(inputFile, '$\\RR$ and $\\ce{H2O}$\n')

    const config = {
      export: {
        cslLibrary: '',
        cslStyle: '',
        stripTags: false,
        stripLinks: 'no' as const,
        enforceMarkSupport: false
      },
      zkn: { linkFormat: 'link|title' as const }
    }
    const defaultsFile = await writeDefaults(
      YAML.parse(await readFile('static/defaults/HTML.yaml', { encoding: 'utf8' })),
      {
        'input-files': [ inputFile ],
        'output-file': outputFile,
        standalone: true
      },
      config,
      [],
      directory,
      component
    )

    await runPandoc(defaultsFile, outputFile)
    const { stdout, stderr } = await execFileAsync('xvfb-run', [
      '-a',
      'chromium',
      '--headless',
      '--no-sandbox',
      '--allow-file-access-from-files',
      '--enable-logging=stderr',
      '--v=0',
      '--virtual-time-budget=10000',
      `--screenshot=${screenshot}`,
      '--dump-dom',
      pathToFileURL(outputFile).href
    ])

    assert.strictEqual((stdout.match(/<mjx-container/g) ?? []).length, 2)
    assert.ok(!stdout.includes('$\\RR$'))
    assert.ok(!stdout.includes('$\\ce{H2O}$'))
    assert.ok(stdout.includes('data-latex="\\mathbb{R}"'))
    assert.ok(stdout.includes('data-latex="\\ce{H2O}"'))
    assert.ok(!stderr.includes("MathJax Warning: Package 'mhchem' not found"))
  })
  it('writes copied Reveal defaults through the exporter seam before real Pandoc output', async function () {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zettlr-pandoc-write-defaults-'))
    const defaultsDirectory = path.join(directory, 'defaults')
    const filterDirectory = path.join(directory, 'filters')
    const inputFile = path.join(directory, 'input.md')
    const outputFile = path.join(directory, 'output.html')
    const existingHeader = path.join(directory, 'existing.html')
    const copiedDefaults = path.join(defaultsDirectory, 'Copied Reveal.yaml')
    const component = path.join(directory, 'assets', 'defaults', 'mathjax-tex-chtml.js')
    const template = path.join(directory, 'project-template.html')

    await mkdir(defaultsDirectory, { recursive: true })
    await mkdir(filterDirectory, { recursive: true })
    await mkdir(path.dirname(component), { recursive: true })
    await cp('static/defaults/Reveal.js.yaml', copiedDefaults)
    await cp('node_modules/@mathjax/src/bundle/tex-chtml.js', component)
    await writeFile(inputFile, '$\\RR$ and $\\ce{H2O}$\n')
    await writeFile(existingHeader, '<meta name="preserved-header" content="yes">')
    await writeFile(template, '<!doctype html><html><head>$for(include-in-header)$$include-in-header$$endfor$</head><body>$body$</body></html>')

    const config = {
      export: {
        cslLibrary: '',
        cslStyle: '',
        stripTags: false,
        stripLinks: 'no' as const,
        enforceMarkSupport: false
      },
      zkn: { linkFormat: 'link|title' as const }
    }
    const defaultsFile = await writeDefaults(
      YAML.parse(await readFile(copiedDefaults, { encoding: 'utf8' })),
      {
        'input-files': [ inputFile ],
        'output-file': outputFile,
        standalone: true,
        template,
        'include-in-header': [ existingHeader ]
      },
      config,
      [],
      directory,
      component
    )
    const defaults = YAML.parse(await readFile(defaultsFile, { encoding: 'utf8' })) as Record<string, unknown>
    const headers = defaults['include-in-header'] as string[]
    const html = await runPandoc(defaultsFile, outputFile)

    assert.strictEqual(defaults.writer, 'revealjs')
    assert.strictEqual(defaults.template, template)
    assert.strictEqual(headers[0], existingHeader)
    assert.strictEqual(headers.length, 2)
    assert.match(await readFile(headers[1], { encoding: 'utf8' }), /window\.MathJax/)
    assert.match(html, /<section class="slide level6">/)
    assert.match(html, /\\RR/)
    assert.match(html, /\\ce\{H2O\}/)
  })
  it('classifies copied Reveal, PDF, and plain-text profile defaults at the shared header seam', async function () {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zettlr-pandoc-profiles-'))
    const existingHeader = path.join(directory, 'existing-header')
    const component = path.join(directory, 'mathjax', 'tex-chtml.js')
    const fixtureNames = [ 'Reveal.js.yaml', 'XeLaTeX PDF.yaml', 'Plain Text.yaml' ]
    const profileDirectories = [ 'reveal', 'pdf', 'plain' ].map(name => path.join(directory, name))
    await Promise.all(profileDirectories.map(async (profileDirectory, index) => {
      await mkdir(profileDirectory, { recursive: true })
      await cp(path.join('static/defaults', fixtureNames[index]), path.join(profileDirectory, 'copied-defaults.yaml'))
    }))
    const profiles = await Promise.all(profileDirectories.map(async profileDirectory => YAML.parse(await readFile(path.join(profileDirectory, 'copied-defaults.yaml'), { encoding: 'utf8' })) as Record<string, unknown>))

    await writeFile(existingHeader, 'preserved')
    await mkdir(path.dirname(component), { recursive: true })
    await cp('node_modules/@mathjax/src/bundle/tex-chtml.js', component)

    for (const [index, defaults] of profiles.entries()) {
      defaults['include-in-header'] = [ existingHeader ]
      await injectPandocMathHeaders(defaults, profileDirectories[index], component)
    }

    const [ reveal, pdf, plain ] = profiles
    const revealHeaders = reveal['include-in-header'] as string[]
    const pdfHeaders = pdf['include-in-header'] as string[]

    assert.strictEqual(revealHeaders[0], existingHeader)
    assert.strictEqual(pdfHeaders[0], existingHeader)
    assert.strictEqual(revealHeaders.length, 2)
    assert.strictEqual(pdfHeaders.length, 2)
    assert.match(await readFile(revealHeaders[1], { encoding: 'utf8' }), /window\.MathJax/)
    assert.match(await readFile(pdfHeaders[1], { encoding: 'utf8' }), /\\usepackage\[version=4\]\{mhchem\}/)
    assert.deepStrictEqual(plain['include-in-header'], [ existingHeader ])
  })

  it('runs real Pandoc TeX with projected macros while preserving existing headers', async function () {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zettlr-pandoc-tex-'))
    const inputFile = path.join(directory, 'input.md')
    const outputFile = path.join(directory, 'output.tex')
    const defaultsFile = path.join(directory, 'defaults.yaml')
    const existingHeader = path.join(directory, 'existing.tex')
    const defaults = YAML.parse(await readFile('static/defaults/LaTeX.yaml', { encoding: 'utf8' })) as Record<string, unknown>
    defaults.standalone = true
    defaults['input-files'] = [ inputFile ]
    defaults['output-file'] = outputFile
    defaults['include-in-header'] = [ existingHeader ]

    await writeFile(inputFile, '$\\RR$ and $\\ce{H2O}$\n')
    await writeFile(existingHeader, '\\newcommand{\\Preserved}{yes}')
    await injectPandocMathHeaders(defaults, directory, path.join(directory, 'unused.js'))
    await writeFile(defaultsFile, Object.entries(defaults).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n'))

    const tex = await runPandoc(defaultsFile, outputFile)

    assert.match(tex, /\\usepackage\[version=4\]\{mhchem\}/)
    assert.match(tex, /\\newcommand\{\\RR\}\{\\mathbb\{R\}\}/)
    assert.match(tex, /\\newcommand\{\\Preserved\}\{yes\}/)
  })
})
