import { promises as fs } from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { mathJaxConfig } from '@common/util/mathjax-config'
import { parseReaderWriter } from '@common/pandoc-util/parse-reader-writer'
import { projectTexHeader } from './macro-projections'

function headerFiles (defaults: Record<string, unknown>): string[] {
  const headers = defaults['include-in-header']

  if (headers === undefined) {
    return []
  }
  if (typeof headers === 'string') {
    return [headers]
  }
  if (Array.isArray(headers) && headers.every(header => typeof header === 'string')) {
    return headers
  }

  throw new TypeError('Pandoc include-in-header must be a string or an array of strings')
}

function isHtmlWriter (writer: string): boolean {
  return [ 'html', 'html4', 'html5', 'revealjs', 's5', 'slidy', 'dzslides' ].includes(writer)
}

function isTexWriter (writer: string): boolean {
  return [ 'beamer', 'latex', 'pdf' ].includes(writer)
}

/**
 * Writes format-specific macro headers and attaches them to Pandoc defaults.
 */
export async function injectPandocMathHeaders (
  defaults: Record<string, unknown>,
  temporaryDirectory: string,
  mathJaxComponent: string
): Promise<void> {
  const writer = parseReaderWriter(defaults.writer as string).name

  if (isHtmlWriter(writer)) {
    const header = path.join(temporaryDirectory, 'zettlr-mathjax-header.html')
    const fontDirectory = path.join(path.dirname(mathJaxComponent), 'mathjax-font')
    const config = JSON.stringify({
      loader: {
        paths: {
          tex: `${pathToFileURL(path.join(path.dirname(mathJaxComponent), 'mathjax-tex-extensions')).href}/`,
          fonts: `${pathToFileURL(path.dirname(mathJaxComponent)).href}/`
        },
        load: ['[tex]/mhchem']
      },
      tex: {
        inlineMath: { '[+]': [[ '$', '$' ]] },
        packages: { '[+]': mathJaxConfig.packages.slice(1) },
        macros: mathJaxConfig.macros
      },
      chtml: {
        fontURL: pathToFileURL(path.join(fontDirectory, 'woff2')).href,
        dynamicPrefix: pathToFileURL(path.join(fontDirectory, 'dynamic')).href
      }
    }, null, 2).replace(/<\/script/gi, '<\\/script')

    await fs.writeFile(header, `<script>\nwindow.MathJax = ${config};\n</script>\n<script defer src="${pathToFileURL(mathJaxComponent).href}"></script>\n`, { encoding: 'utf8' })
    defaults['include-in-header'] = [ ...headerFiles(defaults), header ]
    delete defaults['html-math-method']
  } else if (isTexWriter(writer)) {
    const header = path.join(temporaryDirectory, 'zettlr-mathjax-header.tex')
    await fs.writeFile(header, `\\usepackage[version=4]{mhchem}\n${projectTexHeader(mathJaxConfig.macros)}\n`, { encoding: 'utf8' })
    defaults['include-in-header'] = [ ...headerFiles(defaults), header ]
  }
}
