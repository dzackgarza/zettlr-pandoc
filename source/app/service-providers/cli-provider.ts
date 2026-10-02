/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        cli-provider class
 * CVM-Role:        Service Provider
 * Authorr:         Felix Nüsse
 * License:         GNU GPL v3
 *
 * Description:     This class handles the cli-arguments.
 *                  It can be used to query arguments, as
 *                  long as they are defined in the options object.
 *
 * END HEADER
 */

import { app } from "electron";

/** The command-line options that take a value, as in --data-dir=FILEPATH. */
export type CLIValueOption = "data-dir";

/** The command-line switches, which are either present or absent. */
export type CLISwitch =
  | "disable-hardware-acceleration"
  | "clear-cache"
  | "launch-minimized"
  | "open-in-running-instance";

/**
 * Returns what was passed to the zettlr executable for a known option.
 *
 * @param key  The option to check.
 *
 * @return  For a value option, the value of --option=value, or undefined if
 *          the option was not passed. For a switch, whether it was passed.
 */
export function getCLIArgument(key: CLIValueOption): string | undefined;
export function getCLIArgument(key: CLISwitch): boolean;
export function getCLIArgument(key: CLIValueOption | CLISwitch): string | boolean | undefined {
  switch (key) {
    case "data-dir": {
      return getArgumentValue("--data-dir");
    }
    case "clear-cache": {
      return process.argv.includes("--clear-cache");
    }
    case "disable-hardware-acceleration": {
      return process.argv.includes("--disable-hardware-acceleration");
    }
    case "launch-minimized": {
      return process.argv.includes("--launch-minimized") || process.argv.includes("-m");
    }
    case "open-in-running-instance": {
      return process.argv.includes("--open-in-running-instance");
    }
  }
}

/**
 * This function scans the provided arguments to see if there is an argument,
 * such as `--help` or `--version`, after which the app should quit instead of
 * continuing to boot.
 *
 * NOTE: Ensure this function runs as early as possible, since the app will exit
 * afterwards.
 */
export function handleExitArguments(): void {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    showHelp();
    process.exit();
  }

  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    console.log(app.getName() + " " + app.getVersion());
    process.exit();
  }
}

/**
 * Print a small CLI help on stdout.
 */
function showHelp(): void {
  console.log(`usage: ${app.getName()} [option] [files...]`);
  console.log("Options and arguments:");
  console.log("-h  --help                            Show this help and exit");
  console.log("-v  --version                         Show the version string and exit");
  console.log("    --clear-cache                     Clears the FSAL cache upon startup");
  console.log("    --disable-hardware-acceleration   Disables hardware acceleration");
  console.log("    --data-dir=FILEPATH               Use FILEPATH as the appData directory");
  console.log("-m  --launch-minimized                Start Zettlr mimimized to the tray/menu bar");
  console.log(
    "    --open-in-running-instance        Open the files in an already running Zettlr and exit; fail if none is running",
  );
}

/**
 * This allows to get a raw, unprocessed value for any argument passed via ClI.
 * The passed argument has to be either of the format -x=y or --xlong=y.
 *
 * @param key  {string}   This is the key to be checked. OMIT the equals sign, eg. -x or --xlong; NOT -x=y.
 *
 * @return  {string}      If the key is of the format -x=y, --xlong=y, a string with y is returned
 * @return  {undefined}   If the key was not passed or is not of the format specified in the description.
 */
export function getArgumentValue(key: string): string | undefined {
  const argument = process.argv.find((elem) => elem.indexOf(key + "=") === 0);
  if (argument === undefined) {
    return undefined;
  }

  const match = /="?([^"]+)"?$/.exec(argument);
  if (match !== null) {
    return match[1];
  }
}
