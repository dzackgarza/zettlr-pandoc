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
import { app, dialog } from "electron";
import { promises as fs } from "fs";
import path from "path";
import tls from "tls";
import { getProgramVersion } from "./get-program-version";
import isTraySupported from "./is-tray-supported";
import { preflight } from "./preflight";
import { runCommand } from "./run-command";

/** What environmentCheck() found. The check runs once, before the app boots. */
export interface CheckedEnvironment {
  pandocVersion: string;
  quartoVersion: string | undefined;
  gitVersion: string | undefined;
  tray: TraySupport;
}

let checkedEnvironmentResult: CheckedEnvironment | undefined;

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

  // The preflight has found pandoc on the launch PATH, so it must report a version.
  const pandocVersion = await getProgramVersion("pandoc");
  if (pandocVersion === undefined) {
    throw new Error("pandoc is on PATH but did not report a version.");
  }

  // Now, let's see if there's a quarto package installed
  let quartoVersion: string | undefined;
  try {
    quartoVersion = await getProgramVersion("quarto");
    console.log(
      `[Application] Found a system-wide Quarto install! Version ${String(quartoVersion)}`,
    );
  } catch (err) {
    // No system wide install
    console.log(
      "[Application] Quarto not found on system. *.qmd-files will be exported with Pandoc.",
    );
  }

  // Finally, determine if git is installed on this machine.
  let gitVersion: string | undefined;
  try {
    // On macOS, the `git` command always exists. If the user has installed the
    // XCode command line tools, it will resolve to the actual git binary.
    // However, on Macs without XCode command line tools, it will instead
    // trigger an annoying popup asking to install the command line tools. To
    // figure out if git is installed on macOS, we have to go another route and
    // check the return code of `xcode-select -p`. If it's 0, we are good to go
    // to check for git availability (because the command line tools are
    // intalled). NOTE that we cannot use the recommended tool by apple, `xcrun`
    // because that will *also* trigger the setup dialog.
    let XCodeCLIToolsInstalled = false;
    if (process.platform === "darwin") {
      const xcodeResult = await runCommand("xcode-select", ["-p"]);
      XCodeCLIToolsInstalled = xcodeResult.code === 0;
    }

    if (process.platform !== "darwin" || XCodeCLIToolsInstalled) {
      gitVersion = await getProgramVersion("git");
    }
  } catch (err) {
    // git is absent or did not report a version; gitVersion stays undefined.
    console.log(
      `[Application] git not found on system: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

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
