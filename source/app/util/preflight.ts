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

export const REQUIRED_COMMANDS: CommandRequirement[] = [
  { command: "pandoc", purpose: "preview and export" },
  { command: "just", purpose: "PDF export" },
  { command: "latexmk", purpose: "PDF export" },
  { command: "pdflatex", purpose: "PDF export" },
  { command: "biber", purpose: "PDF bibliography generation" },
  { command: "pandoc-crossref", purpose: "cross-references in Project exports" },
  { command: "latexpand", purpose: "the macros of a TeX export" },
];

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
      target: path.join(pandocDir, "templates", "standalone-tikz.tex"),
      purpose: "TikZ preview rendering",
    },
  ];
}

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

export type CrossrefCompatibility =
  | {
      status: "compatible" | "incompatible";
      crossrefBuiltWithPandoc: string;
      pandocVersion: string;
    }
  | { status: "unparseable"; crossrefBuiltWithPandoc?: string; pandocVersion?: string };

export function assessCrossrefCompatibility(
  crossrefVersionOutput: string,
  pandocVersionOutput: string,
): CrossrefCompatibility {
  const crossrefMatch = /built with Pandoc v(\d[\d.]*)/.exec(crossrefVersionOutput);
  const pandocMatch = /^pandoc(?:\.exe)?\s+(\d[\d.]*)/.exec(pandocVersionOutput.split("\n")[0]);

  const crossrefBuiltWithPandoc = crossrefMatch?.[1];
  const pandocVersion = pandocMatch?.[1];

  if (crossrefBuiltWithPandoc === undefined || pandocVersion === undefined) {
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

export async function tikzFilterCompatibilityFailure(): Promise<string | null> {
  const pandocDir = path.join(os.homedir(), ".pandoc");
  const filterPath = path.join(pandocDir, "filters", "tikzcd.lua");
  if (!resolvesToFile(filterPath)) {
    return null;
  }
  const actual = tikzRenderProtocolVersion(pandocDir);
  if (actual === TIKZ_RENDER_PROTOCOL) {
    return null;
  }
  return (
    `${filterPath} uses TikZ renderer protocol ${actual === undefined ? "unknown" : actual}; ` +
    `this app requires protocol ${TIKZ_RENDER_PROTOCOL}. Update the TikZ filter under ~/.pandoc.`
  );
}

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
