/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        PDF Exporter plugin
 * CVM-Role:        Controller
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This plugin enables exports into PDF. It offers two variants:
 *                  "chromium-pdf" exports by exporting to HTML and then
 *                  utilising the Chrome print API to generate a PDF. The xelatex
 *                  exporter is more powerful, but requires a full TeX installation
 *                  on the system.
 *
 * END HEADER
 */

import path from 'path'
import { promises as fs } from 'fs'
import { BrowserWindow, type WebContents } from 'electron'
import type { ExporterOptions, ExporterPlugin, ExporterOutput, ExporterAPI } from './types'
import sanitize from 'sanitize-filename'

export async function waitForPrintableHtmlReadiness (webContents: WebContents): Promise<void> {
  await webContents.executeJavaScript(`
    (async () => {
      const mathJax = window.MathJax
      if (mathJax === undefined || mathJax.startup === undefined || mathJax.startup.promise === undefined || mathJax.typesetPromise === undefined) {
        throw new Error('Simple PDF MathJax runtime is unavailable')
      }

      await mathJax.startup.promise
      await mathJax.typesetPromise()
      await document.fonts.ready
      document.documentElement.dataset.readiness = 'mathjax-and-fonts-ready'
    })()
  `)
}

export async function composePdfOperationAndCleanup<T> (operation: Promise<T>, cleanup: Promise<void>): Promise<T> {
  const [ operationOutcome, cleanupOutcome ] = await Promise.all([
    operation.then(
      value => ({ status: 'fulfilled' as const, value }),
      reason => ({ status: 'rejected' as const, reason })
    ),
    cleanup.then(
      () => ({ status: 'fulfilled' as const }),
      reason => ({ status: 'rejected' as const, reason })
    )
  ])

  if (operationOutcome.status === 'fulfilled' && cleanupOutcome.status === 'fulfilled') {
    return operationOutcome.value
  }
  if (operationOutcome.status === 'rejected' && cleanupOutcome.status === 'fulfilled') {
    throw operationOutcome.reason
  }
  if (operationOutcome.status === 'fulfilled' && cleanupOutcome.status === 'rejected') {
    throw cleanupOutcome.reason
  }
  if (operationOutcome.status === 'rejected' && cleanupOutcome.status === 'rejected') {
    throw new AggregateError([ operationOutcome.reason, cleanupOutcome.reason ])
  }
  throw new Error('Unreachable Simple PDF outcome')
}

export const plugin: ExporterPlugin = async function (options: ExporterOptions, sourceFiles: string[], ctx: ExporterAPI): Promise<ExporterOutput> {
  // First file determines the name of the output path, EXCEPT a title is
  // explicitly set.
  const firstName = path.basename(options.sourceFiles[0].name, options.sourceFiles[0].ext)
  const title = (options.defaultsOverride?.title !== undefined) ? sanitize(options.defaultsOverride.title, { replacement: '-' }) : firstName
  const pdfFilePath = path.join(options.targetDirectory, `${title}.pdf`)
  const htmlFilePath = path.join(options.targetDirectory, `${title}.html`)

  // Get the corresponding defaults file
  const defaultKeys = {
    'input-files': sourceFiles,
    'output-file': htmlFilePath
  }

  // Now we'll have to get the correct exporting template
  const allDefaults = (await ctx.listDefaults())
    .filter(e => e.writer === 'html')

  if (allDefaults.length > 1) {
    console.warn(`[SimplePDF Export] More than one suitable format for exporting to HTML found - using first one: ${allDefaults[0].name}`)
  }

  // Write to an intermediary HTML file which we will convert to PDF below.
  const defaultsFile = await ctx.writeDefaults(allDefaults[0].name, defaultKeys)

  // Run Pandoc
  const pandocOutput = await ctx.runPandoc(defaultsFile)

  // Without XeLaTeX, people can still export to PDF using Chromium's print
  // API. Chromium's PDF abilities are actually quite good.
  const printer = new BrowserWindow({
    width: 600,
    height: 800,
    show: false
  })

  const printOperation = printer.loadFile(htmlFilePath)
    .then(async () => {
      await waitForPrintableHtmlReadiness(printer.webContents)
      return await printer.webContents.printToPDF({
        printBackground: false,
        landscape: false,
        pageSize: 'A4'
      })
    })
  const cleanup = async (): Promise<void> => {
    printer.close()
    await fs.unlink(htmlFilePath)
  }
  const pdfData = await composePdfOperationAndCleanup(
    printOperation,
    printOperation.then(cleanup, cleanup)
  )

  await fs.writeFile(pdfFilePath, pdfData)

  // Make sure to propagate the results
  return {
    code: pandocOutput.code,
    stdout: pandocOutput.stdout,
    stderr: pandocOutput.stderr,
    targetFile: pdfFilePath
  }
}
