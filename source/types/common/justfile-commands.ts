/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Justfile command types
 * CVM-Role:        Data Types
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Shared renderer/main-process shape of one repository's
 *                  public top-level Just recipes.
 *
 * END HEADER
 */

export type JustParameterKind = 'singular'|'plus'|'star'

export interface JustRecipeParameter {
  name: string
  kind: JustParameterKind
  hasDefault: boolean
  flag: boolean
  hasValue: boolean
  long: string|null
  short: string|null
  multiple: boolean
  min: string|null
  max: string|null
  help: string|null
}

export interface JustRecipeCommand {
  name: string
  doc: string|null
  group: string|null
  parameters: JustRecipeParameter[]
}

export interface JustRepositoryCommands {
  repoRoot: string
  repoLabel: string
  justfilePath: string
  recipes: JustRecipeCommand[]
}

export interface RunJustRecipeRequest {
  repoRoot: string
  recipe: string
  args: string[]
}
