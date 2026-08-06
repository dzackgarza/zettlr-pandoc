/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Pipeline-integrated export script runner
 * CVM-Role:        Controller
 * Maintainer:      Zettlr Contributors
 * License:         GNU GPL v3
 *
 * Description:     Runs a declared export script: export the source through a
 *                  base Pandoc profile to an intermediate file, then run the
 *                  script command on that Pandoc-processed intermediate. Lets a
 *                  compilation script (latexmk, a converter, a shell pipeline)
 *                  be declared in config as a first-class export Format.
 *
 * END HEADER
 */

import path from 'path'
import os from 'os'
import sanitize from 'sanitize-filename'
import type { ExporterOptions, ExporterOutput, ExporterAPI } from './types'
import type { ConfigOptions } from '@providers/config/get-config-template'
import { WRITER2EXT } from '@common/pandoc-util/pandoc-maps'
import { parseReaderWriter } from '@common/pandoc-util/parse-reader-writer'
import { runShellCommand } from './run-shell-command'
import { splitLines } from './split-lines'

export type ExportScript = ConfigOptions['export']['scripts'][number]

export async function runScriptExport (
  options: ExporterOptions,
  sourceFiles: string[],
  ctx: ExporterAPI,
  script: ExportScript
): Promise<ExporterOutput> {
  const firstName = path.basename(options.sourceFiles[0].name, options.sourceFiles[0].ext)
  const title = options.defaultsOverride?.title !== undefined
    ? sanitize(options.defaultsOverride.title, { replacement: '-' })
    : firstName

  // The intermediate's extension follows the base profile's writer.
  const baseProfile = (await ctx.listDefaults()).find(p => p.name === script.profile)
  if (baseProfile === undefined) {
    throw new Error(`Export script "${script.name}" references unknown base profile "${script.profile}"`)
  }
  if (baseProfile.isInvalid) {
    throw new Error(`Export script "${script.name}" references the unusable base profile "${script.profile}": ${baseProfile.reason}`)
  }
  const baseWriter = parseReaderWriter(baseProfile.writer).name
  const intermediateExt = WRITER2EXT[baseWriter] ?? baseWriter
  const intermediate = path.join(os.tmpdir(), `${title}.intermediate.${intermediateExt}`)

  // 1. Produce the intermediate through the base Pandoc profile.
  const defaultsFile = await ctx.writeDefaults(script.profile, {
    'input-files': sourceFiles,
    'output-file': intermediate
  })
  const pandocOutput = await ctx.runPandoc(defaultsFile)
  if (pandocOutput.code !== 0) {
    return { code: pandocOutput.code, stdout: pandocOutput.stdout, stderr: pandocOutput.stderr, targetFile: intermediate }
  }

  // 2. Run the declared command on the Pandoc-processed intermediate.
  const target = path.join(options.targetDirectory, `${title}.${script.extension}`)
  const cwd = options.cwd ?? path.dirname(intermediate)
  const scriptOutput = await runShellCommand(script.command, [ `'${intermediate}'`, `'${target}'` ], cwd)

  return {
    code: scriptOutput.code,
    stdout: pandocOutput.stdout.concat(splitLines(scriptOutput.stdout)),
    stderr: pandocOutput.stderr.concat(splitLines(scriptOutput.stderr)),
    targetFile: target
  }
}
