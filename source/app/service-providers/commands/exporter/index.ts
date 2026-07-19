/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Export Module
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This module allows exporting files with Pandoc.
 *
 * END HEADER
 */

// Modules
import path from 'path'
import { spawn } from 'child_process'
import YAML from 'yaml'
import { app } from 'electron'
import { promises as fs } from 'fs'

// Utilities
import isFile from '@common/util/is-file'

// Exporters
import type { DefaultsOverride, ExporterAPI, ExporterOptions, ExporterOutput, PandocRunnerOutput } from './types'
import { plugin as DefaultExporter } from './default-exporter'
import { plugin as PDFExporter } from './pdf-exporter'
import { plugin as TextbundleExporter } from './textbundle-exporter'
import type AssetsProvider from '@providers/assets'
import type LogProvider from '@providers/log'
import { type PandocProfileMetadata } from '@providers/assets'
import type { ConfigOptions } from '@providers/config/get-config-template'
import type ConfigProvider from '@providers/config'
import { enableExtension, parseReaderWriter, readerWriterToString } from '@common/pandoc-util/parse-reader-writer'
import { EXT2READER } from '@common/pandoc-util/pandoc-maps'
import { injectPandocMathHeaders } from './pandoc-math-headers'
import { type MathJaxMacro } from '@common/util/mathjax-config'
import { loadMathJaxMacros, mathJaxMacrosPath } from '../../../util/load-mathjax-macros'

/**
 * This function returns faux metadata for the custom export formats the
 * exporter supports which circumvent (or build upon) the Pandoc exporter. These
 * are not defined as regular defaults files, therefore we need to output them
 * here.
 *
 * @return  {PandocProfileMetadata[]}The additional profiles
 */
export function getCustomProfiles (): PandocProfileMetadata[] {
  return [
    {
      name: 'Textbundle.yaml', // Fake name
      reader: 'markdown', // Not completely the truth
      writer: 'textbundle', // Not even supported by Pandoc
      isInvalid: false // IT'S ALL FAKE!
    },
    {
      name: 'Textpack.yaml',
      reader: 'markdown',
      writer: 'textpack',
      isInvalid: false
    },
    {
      name: 'Simple PDF.yaml',
      reader: 'markdown',
      writer: 'simple-pdf',
      isInvalid: false
    }
  ]
}

const PLUGINS = {
  pandoc: DefaultExporter,
  'simple-pdf': PDFExporter,
  textbundle: TextbundleExporter
}

type PandocDefaults = Record<string, unknown> & {
  reader: string
  filters: unknown[]
  bibliography: unknown[]
  metadata: Record<string, unknown> & {
    zettlr: Record<string, unknown>
  }
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizePandocDefaults (value: unknown, filename: string): PandocDefaults {
  if (!isRecord(value) || typeof value.reader !== 'string') {
    throw new Error(`Invalid Pandoc defaults profile: ${filename}`)
  }

  const metadata = isRecord(value.metadata) ? value.metadata : {}
  const zettlr = isRecord(metadata.zettlr) ? metadata.zettlr : {}

  return {
    ...value,
    reader: value.reader,
    filters: Array.isArray(value.filters) ? value.filters : [],
    bibliography: value.bibliography === undefined
      ? []
      : Array.isArray(value.bibliography) ? value.bibliography : [value.bibliography],
    metadata: { ...metadata, zettlr }
  }
}

type DefaultsWriterConfig = {
  export: Pick<ConfigOptions['export'], 'cslLibrary'|'cslStyle'|'stripTags'|'stripLinks'|'enforceMarkSupport'>
  zkn: Pick<ConfigOptions['zkn'], 'linkFormat'>
}

/**
 * Runs the exporter.
 *
 * @param   {ExporterOptions}  options             The options needed to facilitate the export.
 * @param   {any}              [formatOptions={}]  These are options possibly required by a plugin.
 *
 * @return  {Promise<ExporterOutput>}              Resolves with an info object.
 */
export async function makeExport (
  options: ExporterOptions,
  logger: LogProvider,
  config: ConfigProvider,
  assets: AssetsProvider
): Promise<ExporterOutput> {
  // We already know where the exported file will end up, so set the property
  const inputFiles = options.sourceFiles.map(file => file.path)

  // Load the user's MathJax macros once for all defaults written in this export.
  const macros = await loadMathJaxMacros(mathJaxMacrosPath(app.getPath('userData')))

  // This is basically the "plugin API"
  const ctx: ExporterAPI = {
    runPandoc: async (defaults: string) => {
      return await runPandoc(logger, defaults, options.cwd)
    },
    writeDefaults: async (filename: string, overrides: Record<string, unknown> = {}) => {
      const defaults = await assets.getDefaultsFile(filename)

      return await writeDefaults(
        defaults,
        overrides,
        config.get(),
        config.get().export.filters,
        app.getPath('temp'),
        path.join(__dirname, 'assets/defaults/mathjax-tex-chtml.js'),
        macros,
        options.defaultsOverride
      )
    },
    listDefaults: async () => {
      return await assets.listDefaults()
    }
  }

  // Search for the correct plugin to run, and run it. First the custom ones ...
  if ([ 'textbundle', 'textpack' ].includes(options.profile.writer)) {
    return await PLUGINS.textbundle(options, inputFiles, ctx)
  } else if (options.profile.writer === 'simple-pdf') {
    return await PLUGINS['simple-pdf'](options, inputFiles, ctx)
  } else {
    // ... otherwise run the regular Pandoc exporter.
    return await PLUGINS.pandoc(options, inputFiles, ctx)
  }
}

async function runPandoc (logger: LogProvider, defaultsFile: string, cwd?: string): Promise<PandocRunnerOutput> {
  const output: PandocRunnerOutput = {
    code: 0,
    stdout: [],
    stderr: []
  }

  await new Promise<void>((resolve, reject) => {
    const pandocProcess = spawn('pandoc', [ '--defaults', `"${defaultsFile}"` ], {
      // NOTE: This has to be true, because of reasons unbeknownst to me, Pandoc
      // is unable to open the defaultsFile if it is not run from within a shell
      shell: true,
      cwd
    })

    pandocProcess.stdout.on('data', (data) => {
      output.stdout.push(String(data))
    })

    pandocProcess.stderr.on('data', (data) => {
      output.stderr.push(String(data))
    })

    pandocProcess.on('close', (code: number, _signal) => {
      // Code should be 0. To check for errors, check that
      output.code = code
      resolve()
    })

    pandocProcess.on('error', (err) => {
      reject(err)
    })
  })

  // The data doesn't come in clean lines because it's a stream, but it will
  // include linefeeds. In order to enable easy checks (stderr.length === 0,
  // for example), clean up the output.
  output.stderr = output.stderr.join('').split('\n').filter(line => line.trim() !== '')
  output.stdout = output.stdout.join('').split('\n').filter(line => line.trim() !== '')

  if (output.stdout.length > 0) {
    logger.info('This Pandoc run produced additional output.', output.stdout)
  }

  return output
}

// REFERENCE: Full defaults file here: https://pandoc.org/MANUAL.html#default-files

export async function writeDefaults (
  rawDefaults: unknown,
  properties: Record<string, unknown>, // Contains properties that will be written to the defaults
  config: DefaultsWriterConfig,
  filters: string[],
  temporaryDirectory: string,
  mathJaxComponent: string,
  macros: Record<string, MathJaxMacro>,
  defaultsOverride?: DefaultsOverride
): Promise<string> {
  const defaultsFile = path.join(temporaryDirectory, 'defaults.yml')
  const defaults = normalizePandocDefaults(rawDefaults, 'provided defaults')

  const { cslLibrary, cslStyle, stripTags, stripLinks, enforceMarkSupport } = config.export
  const { linkFormat } = config.zkn

  // First step: Reader treatment. Zettlr can modify the reader to align with
  // the user preferences.
  const parsedReader = parseReaderWriter(defaults.reader as string)
  const readsMarkdown = EXT2READER['md'].includes(parsedReader.name)
  
  // The user can choose to use [[link|title]] or [[title|link]] syntax. In
  // order for the Lua filter to work properly and respect the link removal
  // setting upon export, we need to set the appropriate extension if it is not
  // already set in the `reader` property.
  const linkExt = linkFormat === 'link|title'
    ? 'wikilinks_title_after_pipe'
    : 'wikilinks_title_before_pipe'
  enableExtension(parsedReader, linkExt)

  // Same for the `mark` extension which makes Pandoc correctly parse `==mark==`
  if (readsMarkdown && enforceMarkSupport) {
    enableExtension(parsedReader, 'mark')
  }

  // Finally, write the modified reader
  defaults.reader = readerWriterToString(parsedReader)

  // In order to facilitate file-only databases, we need to get the currently
  // selected database. This could break in a lot of places, but until Pandoc
  // respects a file-defined bibliography, this is our best shot.
  // const bibliography = global.citeproc.getSelectedDatabase()
  if (isFile(cslLibrary)) {
    defaults.bibliography.push(cslLibrary)
  }

  if (defaultsOverride?.csl !== undefined && isFile(defaultsOverride.csl)) {
    defaults.csl = defaultsOverride.csl
  } else if (isFile(cslStyle)) {
    defaults.csl = cslStyle
  }

  // Now add metadata values for our GUI settings the user can choose. NOTE that
  // users can also add these manually to their files if they prefer. This way
  // any file's metadata will overwrite anything defined programmatically here
  // in the defaults.
  defaults.metadata.zettlr.strip_tags = stripTags
  defaults.metadata.zettlr.strip_links = stripLinks

  // Potentially override allowed defaults properties
  if (defaultsOverride?.title !== undefined) {
    defaults.metadata.title = defaultsOverride.title
  }

  if (defaultsOverride?.template !== undefined) {
    defaults.template = defaultsOverride.template
  }

  // Prepend the declared, ordered export filter chain before the profile's own
  // filters, so structural filters (e.g. amsthm-env conversion) run before the
  // profile's citeproc rather than in filesystem order.
  defaults.filters = [ ...filters, ...defaults.filters ]

  // After we have added our default keys, let the plugin add their keys, which
  // enables them to override certain keys if necessary.
  for (const key in properties) {
    defaults[key] = properties[key]
  }

  await injectPandocMathHeaders(
    defaults as Record<string, unknown>,
    temporaryDirectory,
    mathJaxComponent,
    macros
  )

  const YAMLOptions = {
    indent: 4,
    simpleKeys: false
  }
  await fs.writeFile(defaultsFile, YAML.stringify(defaults, YAMLOptions), { encoding: 'utf8' })

  // Return the path to the defaults file
  return defaultsFile
}
