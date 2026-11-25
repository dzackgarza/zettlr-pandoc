import { trans } from "@common/i18n-main";
import type { EnvironmentInfo } from "@dts/common/environment";
import {
  resolveTikzTemplatePath,
  type TikzCompletionIPCResponse,
  tikzTemplateCompletions,
} from "@dzack/tikz-render/tikz-render";
import { app, ipcMain } from "electron";
import installExtension, { VUEJS_DEVTOOLS } from "electron-devtools-installer";
import path from "path";
import {
  AppServiceContainer,
  getAppServiceContainer,
  isAppServiceContainerReady,
  setAppServiceContainer,
} from "./app-service-container";
import { getCLIArgument } from "./service-providers/cli-provider";
import { attachAppNavigationHandlers } from "./util/attach-app-navigation-handlers";
import registerCustomProtocols from "./util/custom-protocols";
import environmentCheck, { checkedEnvironment } from "./util/environment-check";
import { updateFlowmark } from "./util/flowmark-update";
import { handleBareChannel } from "./util/handle-ipc-channel";
import {
  loadCanonicalMathJaxMacros,
  loadCanonicalMathJaxPairedDelimiters,
  loadCanonicalTexMacroCommands,
} from "./util/load-mathjax-macros";
import resolveTimespanMs from "./util/resolve-timespan-ms";

export type MathJaxMacrosIPCResponse = Awaited<ReturnType<typeof loadCanonicalMathJaxMacros>>;
export type MathJaxPairedDelimitersIPCResponse = Awaited<
  ReturnType<typeof loadCanonicalMathJaxPairedDelimiters>
>;
export type TexMacroCommandsIPCResponse = Awaited<ReturnType<typeof loadCanonicalTexMacroCommands>>;
export type { TikzCompletionIPCResponse };

let upTimestamp: number;

export async function bootApplication(): Promise<AppServiceContainer> {
  upTimestamp = Date.now();

  await environmentCheck();

  const appServiceContainer = new AppServiceContainer();
  const config = appServiceContainer.config;
  const log = appServiceContainer.log;

  log.info(`こんにちは！ Booting Zettlr at ${(new Date()).toString()}.`);

  const flowmarkTask = appServiceContainer.lrt.registerTask(
    trans("Updating Flowmark"),
    "pandoc-flowmark main",
    undefined,
    false,
  );
  void updateFlowmark().then((outcome) => {
    if (outcome.ok) {
      appServiceContainer.lrt.settleTask(flowmarkTask);
      log.info("[Flowmark] Up to date with pandoc-flowmark main.");
      void appServiceContainer.documentLint.flowmarkUpdated();
      return;
    }
    log.warning(`[Flowmark] Could not update from pandoc-flowmark main: ${outcome.message}`);
    const reason = outcome.message.trim().split("\n").pop() ?? outcome.message;
    appServiceContainer.lrt.settleTask(flowmarkTask, new Error(reason));
  });

  if (getCLIArgument("vue-devtools")) {
    log.info("Installing the Vue.js devtools extension ...");
    const extension = await installExtension(VUEJS_DEVTOOLS);
    log.info(`Added extension: ${extension.name} v${extension.version}`);
  }

  registerCustomProtocols(log);

  attachAppNavigationHandlers(log);

  handleBareChannel("mathjax-macros", async () => {
    return await loadCanonicalMathJaxMacros(app.getPath("home"));
  });
  handleBareChannel("mathjax-paired-delimiters", async () => {
    return await loadCanonicalMathJaxPairedDelimiters(app.getPath("home"));
  });
  handleBareChannel("tex-macro-commands", async () => {
    const vocabulary = await loadCanonicalTexMacroCommands(app.getPath("home"));
    for (const source of vocabulary.notRead) {
      log.warning(`[Macros] The completion list has no command of ${source.path}: ${source.cause}`);
    }
    return vocabulary;
  });
  handleBareChannel("tikz-completion-commands", () => {
    return tikzTemplateCompletions(resolveTikzTemplatePath(app.getPath("home")));
  });

  await appServiceContainer.boot();

  setAppServiceContainer(appServiceContainer);

  const environment = checkedEnvironment();

  const environmentInfo: EnvironmentInfo = {
    programVersions: {
      pandoc: environment.pandocVersion,
      quarto: environment.quartoVersion,
      git: environment.gitVersion,
    },
    tray: environment.tray,
  };
  ipcMain.on("environment-info", (event) => {
    event.returnValue = environmentInfo;
  });

  return appServiceContainer;
}

export async function shutdownApplication(): Promise<void> {
  if (!isAppServiceContainerReady()) {
    return;
  }
  const appServiceContainer = getAppServiceContainer();
  const log = appServiceContainer.log;
  log.info(`さようなら！ Shutting down at ${(new Date()).toString()}`);

  const downTimestamp = Date.now();

  const span = resolveTimespanMs(downTimestamp - upTimestamp);

  let uptimeMessage: string = `${span.minutes} minutes, and ${span.seconds}.${span.ms} seconds`;
  if (span.hours > 0) {
    uptimeMessage = `${span.hours} hours, ${uptimeMessage}`;
  }
  if (span.days > 0) {
    uptimeMessage = `${span.days} days, ${uptimeMessage}`;
  }
  if (span.weeks > 0) {
    uptimeMessage = `${span.weeks} weeks, ${uptimeMessage}`;
  }

  log.info(`Application uptime was: ${uptimeMessage}.`);

  if (span.days > 0 || span.weeks > 0) {
    log.warning(
      "Zettlr has run for more than one day. Please make sure to regularly reboot your computer.",
    );
  }

  await appServiceContainer.shutdown();
}
