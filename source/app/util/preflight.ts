/**
 * @ignore
 * BEGIN HEADER
 *
 * CVM-Role:        Utility function
 * Maintainer:      Zettlr Contributors
 * License:         GNU GPL v3
 *
 * Description:     Startup preflight. Verifies that every external tool and file
 *                  the app hard-requires actually resolves in the app's runtime
 *                  environment (the PATH the app was started with), and fails
 *                  loud and fast if any is missing -- instead of surfacing a
 *                  cryptic failure deep inside an export. No fallbacks: a
 *                  missing requirement stops the app at boot.
 *
 * END HEADER
 */

// The FOLLOW-SYMLINKS variant (not @common/util/is-file, which lstats): a
// symlinked ~/.pandoc/justfile is perfectly usable and must pass preflight.
import resolvesToFile from "@common/util/resolves-to-file";
import { describeProbe, probeTool } from "@dzack/external-process/probe-tool";
import { TIKZ_RENDER_PROTOCOL, tikzRenderProtocolVersion } from "@dzack/tikz-render/tikz-render";
import os from "os";
import path from "path";

export interface CommandRequirement {
  command: string;
  purpose: string;
}
export interface PathRequirement {
  target: string;
  purpose: string;
}

/**
 * External commands this fork cannot function without. The PDF export pipeline
 * delegates to the ~/.pandoc `compile-pandoc` recipe, which shells out to pandoc,
 * latexmk, pdflatex, and biber; `just` runs the recipe itself. A TeX export
 * flattens the macro package of ~/.pandoc with latexpand.
 */
export const REQUIRED_COMMANDS: CommandRequirement[] = [
  { command: "pandoc", purpose: "preview and export" },
  { command: "just", purpose: "PDF export" },
  { command: "latexmk", purpose: "PDF export" },
  { command: "pdflatex", purpose: "PDF export" },
  { command: "biber", purpose: "PDF bibliography generation" },
  { command: "pandoc-crossref", purpose: "cross-references in Project exports" },
  { command: "latexpand", purpose: "the macros of a TeX export" },
];

/**
 * Files that must exist on disk for core functionality.
 */
export function requiredPaths(): PathRequirement[] {
  const pandocDir = path.join(os.homedir(), ".pandoc");
  return [
    {
      target: path.join(pandocDir, "justfile"),
      purpose: "PDF export",
    },
    {
      target: path.join(pandocDir, "filters", "tikzcd.lua"),
      purpose: "TikZ preview rendering",
    },
    {
      target: path.join(pandocDir, "filters", "utilities.lua"),
      purpose: "TikZ preview rendering",
    },
    {
      target: path.join(pandocDir, "templates", "standalone-tikz.tex"),
      purpose: "TikZ preview rendering",
    },
  ];
}

/**
 * Returns a human-readable list of every missing requirement (empty = all
 * present). Electron-free so it can be exercised directly in tests. Each
 * command is probed one time (`probeTool`, with its time limit); the probes
 * run at the same time, so the slowest of them, not their sum, is the time
 * of the check. A probe names its cause: a tool that is not on the PATH, one
 * that is not executable, one that does not answer.
 */
export async function findMissingRequirements(
  commands: CommandRequirement[],
  paths: PathRequirement[],
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const probes = await Promise.all(
    commands.map(async ({ command }) => await probeTool(command, env)),
  );
  const missing: string[] = [];
  commands.forEach(({ command, purpose }, index) => {
    const probe = probes[index];
    if (probe.status !== "available") {
      missing.push(`${describeProbe(command, probe)} (needed for ${purpose})`);
    }
  });
  for (const { target, purpose } of paths) {
    if (!resolvesToFile(target)) {
      missing.push(`${target} — missing (${purpose})`);
    }
  }
  return missing;
}

/**
 * The typed outcome of the pandoc-crossref <-> pandoc compatibility check
 * (issue #1 Phase 7).
 *
 * CONTRACT (locked red by test/preflight-crossref.spec.ts):
 *
 * - `crossrefBuiltWithPandoc` is the Pandoc version pandoc-crossref names in
 *   its own `--version` output ("… built with Pandoc vX.Y.Z …" -> 'X.Y.Z').
 * - `pandocVersion` is the version of the installed pandoc, parsed from the
 *   FIRST line of `pandoc --version` ('pandoc X.Y.Z' -> 'X.Y.Z').
 * - status 'compatible' iff both parse and are exactly equal; 'incompatible'
 *   iff both parse and differ; 'unparseable' when either output does not
 *   yield a version (that side's field stays undefined).
 */
export type CrossrefCompatibility =
  | {
      status: "compatible" | "incompatible";
      crossrefBuiltWithPandoc: string;
      pandocVersion: string;
    }
  | { status: "unparseable"; crossrefBuiltWithPandoc?: string; pandocVersion?: string };

/**
 * The pure comparison at the heart of the compatibility check: given the two
 * captured `--version` outputs, decides compatibility per the
 * CrossrefCompatibility contract above.
 *
 * @param   {string}  crossrefVersionOutput   Captured `pandoc-crossref --version` stdout
 * @param   {string}  pandocVersionOutput     Captured `pandoc --version` stdout
 *
 * @return  {CrossrefCompatibility}           The typed compatibility outcome
 */
export function assessCrossrefCompatibility(
  crossrefVersionOutput: string,
  pandocVersionOutput: string,
): CrossrefCompatibility {
  const crossrefMatch = /built with Pandoc v(\d[\d.]*)/.exec(crossrefVersionOutput);
  const pandocMatch = /^pandoc(?:\.exe)?\s+(\d[\d.]*)/.exec(pandocVersionOutput.split("\n")[0]);

  const crossrefBuiltWithPandoc = crossrefMatch?.[1];
  const pandocVersion = pandocMatch?.[1];

  if (crossrefBuiltWithPandoc === undefined || pandocVersion === undefined) {
    // A side that does not name its version cannot be assumed compatible.
    const unparseable: Extract<CrossrefCompatibility, { status: "unparseable" }> = {
      status: "unparseable",
    };
    if (crossrefBuiltWithPandoc !== undefined) {
      unparseable.crossrefBuiltWithPandoc = crossrefBuiltWithPandoc;
    }
    if (pandocVersion !== undefined) {
      unparseable.pandocVersion = pandocVersion;
    }
    return unparseable;
  }

  return {
    status: crossrefBuiltWithPandoc === pandocVersion ? "compatible" : "incompatible",
    crossrefBuiltWithPandoc,
    pandocVersion,
  };
}

/**
 * Reads the `--version` outputs of pandoc-crossref and pandoc from their
 * probes (`probeTool`: one start of each tool for a PATH) and assesses their
 * compatibility. Undefined when a tool did not answer its probe: the presence
 * check of REQUIRED_COMMANDS names that cause.
 */
export async function checkCrossrefCompatibility(
  env: NodeJS.ProcessEnv,
): Promise<CrossrefCompatibility | undefined> {
  const [crossref, pandoc] = await Promise.all([
    probeTool("pandoc-crossref", env),
    probeTool("pandoc", env),
  ]);
  if (crossref.status !== "available" || pandoc.status !== "available") {
    return undefined;
  }
  return assessCrossrefCompatibility(crossref.versionOutput, pandoc.versionOutput);
}

/**
 * The failure message of a compatibility outcome: null when pandoc-crossref
 * names the installed pandoc version, and otherwise a message that names
 * BOTH versions (the one pandoc-crossref was built with and the installed
 * pandoc). preflight() treats a message exactly like a missing requirement.
 */
export function crossrefCompatibilityFailure(result: CrossrefCompatibility): string | null {
  if (result.status === "compatible") {
    return null;
  }

  if (result.status === "incompatible") {
    return (
      `pandoc-crossref was built for Pandoc v${result.crossrefBuiltWithPandoc}, ` +
      `but Pandoc v${result.pandocVersion} is installed. Install matching versions before exporting Projects.`
    );
  }

  return (
    "Could not verify that pandoc-crossref matches the installed Pandoc version " +
    `(pandoc-crossref: ${result.crossrefBuiltWithPandoc !== undefined ? `Pandoc v${result.crossrefBuiltWithPandoc}` : "version unknown"}; ` +
    `Pandoc: ${result.pandocVersion !== undefined ? `v${result.pandocVersion}` : "version unknown"}).`
  );
}

/**
 * The live TikZ preview relies on behavior in the shared ~/.pandoc filter
 * (cache refresh, cache isolation, safe replacement). Presence alone is not
 * enough: a stale checkout would accept the render command but silently violate
 * those semantics. The protocol marker makes that drift a startup error.
 */
export async function tikzFilterCompatibilityFailure(): Promise<string | null> {
  const pandocDir = path.join(os.homedir(), ".pandoc");
  const filterPath = path.join(pandocDir, "filters", "tikzcd.lua");
  if (!resolvesToFile(filterPath)) {
    return null; // requiredPaths() owns the missing-file diagnostic.
  }
  const actual = tikzRenderProtocolVersion(pandocDir);
  if (actual === TIKZ_RENDER_PROTOCOL) {
    return null;
  }
  return (
    `${filterPath} uses TikZ renderer protocol ${actual === undefined ? "unknown" : actual}; ` +
    `this app requires protocol ${TIKZ_RENDER_PROTOCOL}. Update the TikZ filter files under ~/.pandoc.`
  );
}

/**
 * Runs the preflight. If anything is missing, reports it through `showError`,
 * calls `exit(1)`, and resolves false. Otherwise resolves true. The failure
 * side effects are injected so the whole path is testable without Electron.
 * The pandoc-crossref <-> pandoc compatibility gate (issue #1 Phase 7) is
 * part of the preflight: an incompatibility is reported exactly like a
 * missing requirement. The gates run at the same time, and each tool starts
 * one time: the gate reads the version outputs of the probes.
 *
 * @param   showError       Presents a fatal message to the user (e.g. dialog box).
 * @param   exit            Terminates the process with the given code.
 * @param   env             The environment of the app, whose PATH finds the tools.
 * @param   commands        The required external commands.
 * @param   paths           The required on-disk files.
 */
export async function preflight(
  showError: (title: string, message: string) => void,
  exit: (code: number) => void,
  env: NodeJS.ProcessEnv,
  commands: CommandRequirement[] = REQUIRED_COMMANDS,
  paths: PathRequirement[] = requiredPaths(),
): Promise<boolean> {
  const [missing, compatibility, tikzIncompatibility] = await Promise.all([
    findMissingRequirements(commands, paths, env),
    checkCrossrefCompatibility(env),
    tikzFilterCompatibilityFailure(),
  ]);
  const incompatibility =
    compatibility === undefined ? null : crossrefCompatibilityFailure(compatibility);
  if (incompatibility !== null) {
    missing.push(incompatibility);
  }
  if (tikzIncompatibility !== null) {
    missing.push(tikzIncompatibility);
  }
  if (missing.length === 0) {
    return true;
  }

  const message =
    "Zettlr-Pandoc cannot start — required tools or files are missing:\n\n" +
    missing.map((item) => "  • " + item).join("\n") +
    "\n\nInstall the missing dependencies (or fix the app's PATH), then relaunch.";
  showError("Zettlr-Pandoc — missing dependencies", message);
  exit(1);
  return false;
}
