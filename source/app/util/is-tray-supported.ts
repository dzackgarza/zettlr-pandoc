import { requireExit, runProcess } from "@dzack/external-process/run-process";

/**
 * Check if system supports a Tray.
 *
 * Returns true on Windows and MacOS.
 * Returns true on Linux with Gnome desktop if Gnome Extension
 * 'KStatusNotifierItem/AppIndicator Support' is installed, otherwise throws
 * an {Error} with the reason why.
 * Returns true on Linux with other desktops. e.g. KDE, XFCE, etc.
 *
 * @return {*}  {Promise<boolean>} If supported, returns true. Never returns
 *              false.
 * @throws {Error} Details why the Tray is not supported; or
 *                 Details the error if an error occurred while checking Tray
 *                 support.
 */
export default async function isTraySupported(): Promise<boolean> {
  const isLinux = process.platform === "linux";
  if (isLinux && process.env.XDG_CURRENT_DESKTOP === "GNOME") {
    const answer = requireExit(
      "gsettings",
      await runProcess({
        command: "gsettings",
        args: ["get", "org.gnome.shell", "enabled-extensions"],
        env: process.env,
        timeLimitMs: "none",
        waitForGroup: false,
      }),
    );
    // The translations load after this check, so the message is not
    // translated.
    if (answer.code !== 0 || !answer.stdout.includes("'appindicatorsupport@rgcjonas.gmail.com'")) {
      throw new Error("Your operating system does not support a tray.");
    }
    return true;
  } else {
    return true;
  }
}
