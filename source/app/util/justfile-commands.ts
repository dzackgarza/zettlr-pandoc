/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Justfile command discovery
 * CVM-Role:        Utility
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Finds the Git roots containing open workspaces and asks
 *                  Just itself for the public recipes of a justfile at that
 *                  repository root. No Just syntax is parsed here.
 *
 * END HEADER
 */

import path from 'path'
import { spawn } from 'child_process'
import { z } from 'zod'
import type {
  JustRecipeCommand,
  JustRecipeParameter,
  JustRepositoryCommands
} from '@dts/common/justfile-commands'

export interface CapturedCommand {
  code: number
  stdout: string
  stderr: string
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  cwd?: string
) => Promise<CapturedCommand>

const rawParameterSchema = z.object({
  name: z.string(),
  kind: z.enum([ 'singular', 'plus', 'star' ]),
  default: z.unknown().nullable(),
  flag: z.boolean(),
  value: z.unknown().nullable(),
  long: z.string().nullable(),
  short: z.string().nullable(),
  multiple: z.boolean(),
  min: z.string().nullable(),
  max: z.string().nullable(),
  help: z.string().nullable()
}).passthrough()

const rawRecipeSchema = z.object({
  name: z.string(),
  doc: z.string().nullable(),
  private: z.boolean(),
  parameters: z.array(rawParameterSchema),
  attributes: z.array(z.unknown())
}).passthrough()

const justDumpSchema = z.object({
  source: z.string(),
  recipes: z.record(z.string(), rawRecipeSchema)
}).passthrough()

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recipeGroup (attributes: readonly unknown[]): string|null {
  for (const attribute of attributes) {
    if (isRecord(attribute) && typeof attribute.group === 'string') {
      return attribute.group
    }
  }
  return null
}

function normalizeParameter (parameter: z.infer<typeof rawParameterSchema>): JustRecipeParameter {
  return {
    name: parameter.name,
    kind: parameter.kind,
    hasDefault: parameter.default !== null,
    flag: parameter.flag,
    hasValue: parameter.value !== null,
    long: parameter.long,
    short: parameter.short,
    multiple: parameter.multiple,
    min: parameter.min,
    max: parameter.max,
    help: parameter.help
  }
}

async function captureCommand (
  command: string,
  args: readonly string[],
  cwd?: string
): Promise<CapturedCommand> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [ ...args ], {
      cwd,
      shell: false,
      stdio: [ 'ignore', 'pipe', 'pipe' ]
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', code => {
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

/** Public root recipes of every distinct Git repository containing a workspace. */
export async function discoverJustfileCommands (
  workspaceRoots: readonly string[],
  run: CommandRunner = captureCommand,
  diagnostic: (message: string) => void = () => {}
): Promise<JustRepositoryCommands[]> {
  const repoRoots = new Set<string>()

  for (const workspaceRoot of workspaceRoots) {
    let git: CapturedCommand
    try {
      git = await run('git', [ '-C', workspaceRoot, 'rev-parse', '--show-toplevel' ])
    } catch (err: unknown) {
      diagnostic(`Could not inspect ${workspaceRoot} with git: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    if (git.code !== 0) {
      continue
    }
    const repoRoot = git.stdout.trim()
    if (repoRoot !== '') {
      repoRoots.add(path.resolve(repoRoot))
    }
  }

  const repositories: JustRepositoryCommands[] = []
  for (const repoRoot of repoRoots) {
    let dumped: CapturedCommand
    try {
      dumped = await run(
        'just',
        [ '--ceiling', repoRoot, '--dump', '--dump-format', 'json' ],
        repoRoot
      )
    } catch (err: unknown) {
      diagnostic(`Could not inspect Just recipes in ${repoRoot}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    if (dumped.code !== 0) {
      if (!dumped.stderr.includes('no justfile found')) {
        diagnostic(`Could not inspect Just recipes in ${repoRoot}: ${dumped.stderr.trim()}`)
      }
      continue
    }

    let parsed: z.infer<typeof justDumpSchema>
    try {
      parsed = justDumpSchema.parse(JSON.parse(dumped.stdout) as unknown)
    } catch (err: unknown) {
      diagnostic(`Just returned malformed JSON for ${repoRoot}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }

    // `cwd = repoRoot` and `--ceiling repoRoot` should already force this, but
    // keep the top-level-only requirement explicit at the boundary.
    const justfilePath = path.resolve(parsed.source)
    if (path.dirname(justfilePath) !== repoRoot) {
      diagnostic(`Ignoring non-top-level Justfile ${justfilePath} for repository ${repoRoot}`)
      continue
    }

    const recipes: JustRecipeCommand[] = Object.values(parsed.recipes)
      .filter(recipe => !recipe.private)
      .map(recipe => ({
        name: recipe.name,
        doc: recipe.doc,
        group: recipeGroup(recipe.attributes),
        parameters: recipe.parameters.map(normalizeParameter)
      }))
      .sort((left, right) => left.name.localeCompare(right.name))

    if (recipes.length > 0) {
      repositories.push({
        repoRoot,
        repoLabel: path.basename(repoRoot),
        justfilePath,
        recipes
      })
    }
  }

  return repositories.sort((left, right) => left.repoRoot.localeCompare(right.repoRoot))
}
