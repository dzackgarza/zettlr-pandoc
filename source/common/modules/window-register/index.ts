import { loadData } from "@common/i18n-renderer";
import { initializeMathJax } from "@common/util/mathtex-to-html";
import showToast from "@common/util/show-toast";
import { COMMAND_FAILED_CHANNEL } from "@dts/common/command-failure";
import loadIcons from "./load-icons";
import registerDefaultContextMenu from "./register-default-context";
import registerThemes from "./register-themes";
import { registerRendererErrorCapture } from "./renderer-error-capture";

export default async function windowRegister(): Promise<void> {
  registerRendererErrorCapture();
  window.ipc.on(COMMAND_FAILED_CHANNEL, (_event, failure) => {
    showToast(failure.message, "error", 12000);
  });
  await loadData();
  await loadIcons();

  const [macros, pairedDelimiters] = await Promise.all([
    window.ipc.invoke("mathjax-macros"),
    window.ipc.invoke("mathjax-paired-delimiters"),
  ]);
  await initializeMathJax(macros, pairedDelimiters);

  registerThemes();
  registerDefaultContextMenu();
}
