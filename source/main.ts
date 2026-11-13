/**
 * @ignore
 * BEGIN HEADER
 *
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This is the application's entry file. This gets executed as
 *                  soon as the app starts. Its task is only to hook onto the
 *                  app events and boot the application.
 *
 * END HEADER
 */

import { reportError, stderrError } from "@common/util/error-reporting";
import errorToString from "@common/util/error-to-string";
import { getCLIArgument, handleExitArguments } from "@providers/cli-provider";
import { app, crashReporter } from "electron";
import path from "path";
import { getAppServiceContainer, isAppServiceContainerReady } from "./app/app-service-container";
import { ApplicationLifecycle } from "./app/application-lifecycle";
import {
  acquireLaunch,
  type LaunchOutcome,
  launchRequestSchema,
  replyToLaunch,
} from "./app/launch-request";
import { bootApplication, shutdownApplication } from "./app/lifecycle";
// Helper function to extract files to open from process.argv
import extractFilesFromArgv from "./app/util/extract-files-from-argv";

function logUnhandledProcessError(message: string): void {
  if (isAppServiceContainerReady()) {
    getAppServiceContainer().log.error(message);
  } else {
    reportError(message);
  }
}

process.on("uncaughtExceptionMonitor", (error, origin) => {
  logUnhandledProcessError(`[Application] Uncaught exception (${origin})\n${errorToString(error)}`);
});

handleExitArguments();

// Setting custom data dir for user configuration files.
// Full path or relative path is OK. '~' does not work as expected.
let dataDir = getCLIArgument("data-dir");

if (dataDir !== undefined) {
  // a path to a custom config dir is provided
  if (!path.isAbsolute(dataDir)) {
    if (app.isPackaged) {
      // Attempt to use the executable file's path as the basis
      dataDir = path.join(path.dirname(app.getPath("exe")), dataDir);
    } else {
      // Attempt to use the repository's root directory as the basis
      dataDir = path.join(__dirname, "../../", dataDir);
    }
  }

  if (isAppServiceContainerReady()) {
    getAppServiceContainer().log.info(`[Application] Using custom data dir: ${dataDir}`);
  }
  app.setPath("userData", dataDir);
  app.setAppLogsPath(path.join(dataDir, "logs"));
}

// Write a local minidump for every crashed process into userData/Crashpad.
// Nothing is uploaded. See: https://www.electronjs.org/docs/latest/api/crash-reporter
crashReporter.start({ uploadToServer: false });

// A helper process (GPU, utility, a renderer's zygote child) that exits leaves
// no other record. See: https://www.electronjs.org/docs/latest/api/app#event-child-process-gone
app.on("child-process-gone", (_event, { type, reason, exitCode, name }) => {
  // Electron names only some process types (a utility process, a plugin).
  const helper = name === undefined ? `type=${type}` : `type=${type} name=${name}`;
  logUnhandledProcessError(
    `[Application] Child process gone: ${helper} reason=${reason} exitCode=${exitCode}`,
  );
});

// To show notifications properly on Windows, we must manually set the appUserModelID
// See https://www.electronjs.org/docs/tutorial/notifications#windows
if (process.platform === "win32") {
  app.setAppUserModelId("com.zettlr.app");
}

// On systems with virtual GPUs (i.e. VMs), it might be necessary to disable
// hardware acceleration. If the corresponding flag is set, we do so.
// See for more info https://github.com/Zettlr/Zettlr/issues/2127
if (getCLIArgument("disable-hardware-acceleration")) {
  app.disableHardwareAcceleration();
}

// *****************************************************************************

const restartFiles: string[] = [];
let restartRequested = false;

function failLifecycle(error: Error): void {
  const details = errorToString(error);
  // The packaged app logs to a file only; the launcher reads stderr.
  stderrError(`[Application] Lifecycle failed\n${details}`);
  reportError(details);
  app.exit(1);
}

async function completeNativeActivation(files: string[], outcome: LaunchOutcome): Promise<void> {
  switch (outcome.status) {
    case "ready":
      return;
    case "retry":
      restartRequested = true;
      restartFiles.push(...files);
      return;
    case "error":
      throw new Error(outcome.message);
  }
}

/**
 * Hook into the ready event and initialize the main object creating everything
 * else. It is necessary to wait for the ready event, because prior, some APIs
 * may not work correctly.
 */
const lifecycle = new ApplicationLifecycle({
  async boot() {
    const ownership = await acquireLaunch(
      extractFilesFromArgv().map((file) => path.resolve(file)),
      getCLIArgument("open-in-running-instance") ? "existing" : "launch",
    );
    if (ownership === "delivered") {
      console.log("[Application] Launch complete.");
      app.exit(0);
      return;
    }
    await app.whenReady();
    // Override the about panel options so that a little bit more is being shown.
    // Makes only sense for macOS, as we don't call the showAboutPanel() method
    // programmatically, but either way, it's a little bit nicer.
    app.setAboutPanelOptions({
      applicationName: "Zettlr",
      applicationVersion: app.getVersion(),
      copyright: `Copyright (c) 2017 - ${new Date().getFullYear()} by Hendrik Erz. Licensed via GNU GPL 3.0`,
      // version: If we ever introduce a build number. This defaults to the Electron version.
      credits:
        "We would like to thank all contributors to the app, its translators, and those who meticulously update the documentation.",
      authors: ["Hendrik Erz"], // TODO: Somehow generate the contributors list.
      website: "https://www.zettlr.com/",
      iconPath: process.execPath,
    });
    // Immediately boot the application. This function performs some initial
    // checks to make sure the environment is as expected for Zettlr, and boots
    // up the providers.
    await bootApplication();
    if (!(await getAppServiceContainer().commands.run("roots-add", extractFilesFromArgv()))) {
      throw new Error("Could not open the startup documents");
    }
    console.log("[Application] Boot complete.");
  },
  async open(files) {
    const services = getAppServiceContainer();
    if (!(await services.commands.run("roots-add", files)))
      throw new Error("Could not open the requested documents");
    services.windows.activate();
  },
  shutdown: shutdownApplication,
  release: () => app.releaseSingleInstanceLock(),
  quit() {
    if (restartRequested) app.relaunch({ args: process.argv.slice(1).concat(restartFiles) });
    app.exit(0);
  },
  report: (error) => logUnhandledProcessError(errorToString(error)),
  fail: failLifecycle,
});

/**
 * This event will be called if another instance of Zettlr has been opened with
 * the argv of that instance.
 * NOTE from the electron docs: This event is guaranteed to be emitted after
 * the ready event of app gets emitted.
 * @param {Object} event The instance event
 * @param {Array} argv The arguments the second instance had received
 * @param {String} cwd The current working directory
 */
app.on("second-instance", (_event, _argv, _cwd, data) => {
  const request = launchRequestSchema.parse(data);
  lifecycle.activate(request.files, async (outcome) => {
    if (outcome.status === "retry" && request.mode === "existing") {
      await replyToLaunch(request, {
        status: "error",
        message: "The running instance is shutting down",
      });
    } else {
      await replyToLaunch(request, outcome);
    }
  });
});

/**
 * This gets executed when the user wants to open a file on macOS.
 */
app.on("open-file", (e, filePath) => {
  e.preventDefault(); // Need to explicitly set this b/c we're handling this

  lifecycle.activate([filePath], (outcome) => completeNativeActivation([filePath], outcome));
});

/**
 * Quit as soon as all windows are closed, except on macOS and for a session
 * that stays in the notification area (`keepsSessionRunning`).
 */
app.on("window-all-closed", function () {
  if (!isAppServiceContainerReady()) {
    return;
  }

  if (!getAppServiceContainer().windows.keepsSessionRunning() && process.platform !== "darwin") {
    // On OS X it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    app.quit();
  }
});

/**
 * Hook into the will-quit event to make sure we are able to shut down our app
 * properly.
 */
app.on("will-quit", function (event) {
  event.preventDefault();

  void lifecycle.stop().catch(failLifecycle);
});

/**
 * On macOS, open a new window as soon as the user re-activates the app.
 */
app.on("activate", function () {
  lifecycle.activate([], (outcome) => completeNativeActivation([], outcome));
});

/**
 * Hook into the unhandledRejection-event to prevent nasty error messages when
 * a Promise is rejected somewhere.
 */
process.on("unhandledRejection", (err: unknown) => {
  logUnhandledProcessError(`[Application] Unhandled rejection received\n${errorToString(err)}`);
});
