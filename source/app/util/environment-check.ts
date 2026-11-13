/**
 * @ignore
 * BEGIN HEADER
 *
 * CVM-Role:        Utility function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This function is called on boot and checks the environment
 *                  to ensure a proper functioning of the application.
 *
 * END HEADER
 */

import { reportError } from "@common/util/error-reporting";
import type { TraySupport } from "@dts/common/environment";
import {
  describeProbe,
  PROBE_TIME_LIMIT_MS,
  probeTool,
  type ToolProbe,
} from "@dzack/external-process/probe-tool";
import { describeOutcome, runProcess } from "@dzack/external-process/run-process";
import { app, dialog } from "electron";
import { promises as fs } from "fs";
import path from "path";
import tls from "tls";
import isTraySupported from "./is-tray-supported";
import { preflight } from "./preflight";

/** What environmentCheck() found. The check runs once, before the app boots. */
export interface CheckedEnvironment {
  pandocVersion: string;
  quartoVersion: string | undefined;
  gitVersion: string | undefined;
  tray: TraySupport;
}

let checkedEnvironmentResult: CheckedEnvironment | undefined;

/** The version number on the first line of a `--version` output. */
function versionOf(probe: Extract<ToolProbe, { status: "available" }>): string | undefined {
  return /\d[\d.]+/.exec(probe.versionOutput.split("\n")[0])?.[0];
}

/**
 * The version of git, or undefined when git is not installed.
 *
 * On macOS, the `git` command always exists. If the user has installed the
 * XCode command line tools, it will resolve to the actual git binary.
 * However, on Macs without XCode command line tools, it will instead
 * trigger a popup asking to install the command line tools. To figure out if
 * git is installed on macOS, we check the return code of `xcode-select -p`.
 * If it's 0, the command line tools are installed. NOTE that we cannot use the
 * tool recommended by Apple, `xcrun`, because that will *also* trigger the
 * setup dialog.
 */
async function findGitVersion(): Promise<string | undefined> {
  if (process.platform === "darwin") {
    const xcodeResult = await runProcess({
      command: "xcode-select",
      args: ["-p"],
      env: process.env,
      timeLimitMs: PROBE_TIME_LIMIT_MS,
      waitForGroup: false,
    });
    if (!(xcodeResult.ended === "exit" && xcodeResult.code === 0)) {
      console.log(
        `[Application] git is not checked: ${describeOutcome("xcode-select -p", xcodeResult)}`,
      );
      return undefined;
    }
  }
  const git = await probeTool("git", process.env);
  if (git.status !== "available") {
    console.log(`[Application] ${describeProbe("git", git)}.`);
    return undefined;
  }
  return versionOf(git);
}

/**
 * Returns what the environment check found.
 *
 * @throws {Error} When the environment check has not completed.
 */
export function checkedEnvironment(): CheckedEnvironment {
  if (checkedEnvironmentResult === undefined) {
    throw new Error("The environment check has not completed.");
  }
  return checkedEnvironmentResult;
}

export default async function environmentCheck(): Promise<void> {
  console.log("[Application] Performing environment check ...");

  // Ensure that the Node process trusts both its own bundled certificates
  // (= the default) and the certificates of the system store when making
  // connections.
  const bundled = tls.getCACertificates("bundled");
  const system = tls.getCACertificates("system");
  tls.setDefaultCACertificates([...bundled, ...system]);
  console.log(
    "[Application] Info: The main process now uses both the bundled Mozilla CA as well as the system CA.",
  );

  // Hard preflight: verify every external tool and file the app cannot
  // function without actually resolves in the PATH the app was started with,
  // and fail loud and fast (native error dialog + exit) if any is missing --
  // rather than letting a missing `just`/`latexmk`/recipe surface as a cryptic
  // error mid-export. The app reads no other PATH: a launcher with a wrong
  // PATH is reported here, not repaired.
  const passed = await preflight(
    (title, message) => {
      reportError(`[Application] Preflight FAILED.\n${message}`);
      dialog.showErrorBox(title, message);
    },
    (code) => app.exit(code),
    process.env,
  );
  if (!passed) {
    return; // app.exit(1) was called; do not continue booting.
  }
  console.log("[Application] Preflight OK: all required tooling resolved.");

  /**
   * Required directories that must exist on the system in order for certain
   * functionality to work and not bring down Zettlr to its knees on startup.
   *
   * @var {string[]}
   */
  const REQUIRED_DIRECTORIES = [
    app.getPath("userData"), // Main config directory
    path.join(app.getPath("userData"), "dict"), // Custom dictionary path
    path.join(app.getPath("userData"), "lang"), // Custom translation path
    path.join(app.getPath("userData"), "logs"), // Log path
    path.join(app.getPath("userData"), "defaults"), // Defaults files
    path.join(app.getPath("userData"), "snippets"), // Snippets files
    path.join(app.getPath("userData"), "lua-filter"), // Lua filters
  ];

  const is64Bit = process.arch === "x64";
  const isARM64 = process.arch === "arm64";
  const isDarwin = process.platform === "darwin";
  const isLinux = process.platform === "linux";
  const isWindows = process.platform === "win32";
  const winARM = isWindows && isARM64;
  const macARM = isDarwin && isARM64;
  const linuxARM = isLinux && isARM64;

  if (!winARM && !macARM && !is64Bit && !isLinux && !linuxARM) {
    // We support: Windows ARM and macOS ARM
    // and anything 64bit. Warn for everything else.
    console.warn(
      `[Application] Your platform/arch (${process.platform}/${process.arch}) combination is not officially supported. Zettlr might not function correctly.`,
    );
  }

  // The preflight probed pandoc on the launch PATH; this is the same probe.
  const pandoc = await probeTool("pandoc", process.env);
  if (pandoc.status !== "available") {
    throw new Error(describeProbe("pandoc", pandoc));
  }
  const pandocVersion = versionOf(pandoc);
  if (pandocVersion === undefined) {
    throw new Error(`pandoc --version names no version: ${pandoc.versionOutput}`);
  }

  // Now, let's see if there's a quarto package installed
  let quartoVersion: string | undefined;
  const quarto = await probeTool("quarto", process.env);
  if (quarto.status === "available") {
    quartoVersion = versionOf(quarto);
    console.log(
      `[Application] Found a system-wide Quarto install! Version ${String(quartoVersion)}`,
    );
  } else {
    console.log(
      `[Application] ${describeProbe("quarto", quarto)}. *.qmd-files will be exported with Pandoc.`,
    );
  }

  // Finally, determine if git is installed on this machine.
  const gitVersion = await findGitVersion();

  // Then ensure all required directories exist
  for (const directory of REQUIRED_DIRECTORIES) {
    try {
      await fs.lstat(directory);
    } catch (err) {
      console.log(`[Application] Creating required directory ${directory} ...`);
      await fs.mkdir(directory, { recursive: true });
    }
  }

  // Determine if the platform has Tray support. isTraySupported() resolves
  // true or throws the reason why the tray is unavailable.
  let tray: TraySupport;
  try {
    await isTraySupported();
    tray = { supported: true };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(reason);
    tray = { supported: false, reason };
  }

  checkedEnvironmentResult = { pandocVersion, quartoVersion, gitVersion, tray };

  if (__UPDATES_DISABLED__ === "1") {
    console.warn("This Zettlr binary has been compiled with update checks completely disabled.");
  }

  console.log("[Application] Environment check complete.");
}
