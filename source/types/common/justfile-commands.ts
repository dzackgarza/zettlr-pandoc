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

export type JustParameterKind = "singular" | "plus" | "star";

export interface JustRecipeParameter {
  name: string;
  kind: JustParameterKind;
  hasDefault: boolean;
  flag: boolean;
  hasValue: boolean;
  long: string | null;
  short: string | null;
  multiple: boolean;
  min: string | null;
  max: string | null;
  help: string | null;
}

export interface JustRecipeCommand {
  name: string;
  doc: string | null;
  group: string | null;
  parameters: JustRecipeParameter[];
}

export interface JustRepositoryCommands {
  repoRoot: string;
  repoLabel: string;
  justfilePath: string;
  recipes: JustRecipeCommand[];
}

export interface RunJustRecipeRequest {
  repoRoot: string;
  recipe: string;
  args: string[];
}

/** A Git repository of an open workspace whose recipes Just did not list. */
export interface JustRepositoryNotListed {
  repoRoot: string;
  repoLabel: string;
  /** What `git` or `just` answered. */
  cause: string;
}

/**
 * The public recipes of the repositories of the open workspaces, and each
 * repository whose recipes could not be listed. A repository without a
 * justfile is in neither list.
 */
export interface JustfileListing {
  repositories: JustRepositoryCommands[];
  notListed: JustRepositoryNotListed[];
}
