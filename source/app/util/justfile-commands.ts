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

import { trans } from "@common/i18n-main";
import type {
  JustfileListing,
  JustRecipeCommand,
  JustRecipeParameter,
  JustRepositoryCommands,
  JustRepositoryNotListed,
} from "@dts/common/justfile-commands";
import { spawn } from "child_process";
import path from "path";
import { z } from "zod";

export interface CapturedCommand {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  cwd?: string,
) => Promise<CapturedCommand>;

const rawParameterSchema = z
  .object({
    name: z.string(),
    kind: z.enum(["singular", "plus", "star"]),
    default: z.unknown().nullable(),
    flag: z.boolean(),
    value: z.unknown().nullable(),
    long: z.string().nullable(),
    short: z.string().nullable(),
    multiple: z.boolean(),
    min: z.string().nullable(),
    max: z.string().nullable(),
    help: z.string().nullable(),
  })
  .passthrough();

const rawRecipeSchema = z
  .object({
    name: z.string(),
    doc: z.string().nullable(),
    private: z.boolean(),
    parameters: z.array(rawParameterSchema),
    attributes: z.array(z.unknown()),
  })
  .passthrough();

const justDumpSchema = z
  .object({
    source: z.string(),
    recipes: z.record(z.string(), rawRecipeSchema),
  })
  .passthrough();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recipeGroup(attributes: readonly unknown[]): string | null {
  for (const attribute of attributes) {
    if (isRecord(attribute) && typeof attribute.group === "string") {
      return attribute.group;
    }
  }
  return null;
}

function normalizeParameter(parameter: z.infer<typeof rawParameterSchema>): JustRecipeParameter {
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
    help: parameter.help,
  };
}

async function captureCommand(
  command: string,
  args: readonly string[],
  cwd?: string,
): Promise<CapturedCommand> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      // Node reports a null exit code exactly when a signal ended the process.
      if (code === null) {
        reject(new Error(`${command} was terminated by signal ${String(signal)}`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

/** The answer of a command, or the error that kept it from running. */
async function attempt(
  run: CommandRunner,
  command: string,
  args: readonly string[],
  cwd?: string,
): Promise<CapturedCommand | Error> {
  return await run(command, args, cwd).then(
    (captured) => captured,
    (rejection: Error) => rejection,
  );
}

/** The error output of a command, or its exit code when it wrote none. */
function errorText(captured: CapturedCommand): string {
  const text = captured.stderr.trim();
  return text === "" ? `exit code ${captured.code}` : text;
}

/**
 * The public root recipes of every distinct Git repository that holds a
 * workspace, and each repository whose recipes Git or Just could not give,
 * with the cause. A workspace outside Git and a repository without a
 * justfile have no recipes, which is no failure.
 */
export async function discoverJustfileCommands(
  workspaceRoots: readonly string[],
  run: CommandRunner = captureCommand,
): Promise<JustfileListing> {
  const repoRoots = new Set<string>();
  const notListed: JustRepositoryNotListed[] = [];
  const refuse = (repoRoot: string, cause: string): void => {
    notListed.push({ repoRoot, repoLabel: path.basename(repoRoot), cause });
  };

  for (const workspaceRoot of workspaceRoots) {
    const git = await attempt(run, "git", ["-C", workspaceRoot, "rev-parse", "--show-toplevel"]);
    if (git instanceof Error) {
      refuse(workspaceRoot, trans("Git cannot run: %s", git.message));
      continue;
    }
    if (git.code !== 0) {
      continue; // Not in a Git repository.
    }
    const repoRoot = git.stdout.trim();
    if (repoRoot !== "") {
      repoRoots.add(path.resolve(repoRoot));
    }
  }

  const repositories: JustRepositoryCommands[] = [];
  for (const repoRoot of repoRoots) {
    const dumped = await attempt(
      run,
      "just",
      ["--ceiling", repoRoot, "--dump", "--dump-format", "json"],
      repoRoot,
    );
    if (dumped instanceof Error) {
      refuse(repoRoot, trans("Just cannot run: %s", dumped.message));
      continue;
    }
    if (dumped.code !== 0) {
      if (!dumped.stderr.includes("no justfile found")) {
        refuse(repoRoot, errorText(dumped));
      }
      continue;
    }

    const parsed = await Promise.resolve(dumped.stdout).then(
      (text): z.infer<typeof justDumpSchema> | Error => {
        const dump = justDumpSchema.safeParse(JSON.parse(text));
        return dump.success ? dump.data : new Error(dump.error.message);
      },
      (rejection: Error) => rejection,
    );
    if (parsed instanceof Error) {
      refuse(repoRoot, trans("Just gave recipes in an unknown form: %s", parsed.message));
      continue;
    }

    // `cwd = repoRoot` and `--ceiling repoRoot` should already force this, but
    // keep the top-level-only requirement explicit at the boundary.
    const justfilePath = path.resolve(parsed.source);
    if (path.dirname(justfilePath) !== repoRoot) {
      refuse(repoRoot, trans("%s is not at the root of the repository.", justfilePath));
      continue;
    }

    const recipes: JustRecipeCommand[] = Object.values(parsed.recipes)
      .filter((recipe) => !recipe.private)
      .map((recipe) => ({
        name: recipe.name,
        doc: recipe.doc,
        group: recipeGroup(recipe.attributes),
        parameters: recipe.parameters.map(normalizeParameter),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));

    if (recipes.length > 0) {
      repositories.push({
        repoRoot,
        repoLabel: path.basename(repoRoot),
        justfilePath,
        recipes,
      });
    }
  }

  const byRoot = (left: { repoRoot: string }, right: { repoRoot: string }): number =>
    left.repoRoot.localeCompare(right.repoRoot);
  return { repositories: repositories.sort(byRoot), notListed: notListed.sort(byRoot) };
}
