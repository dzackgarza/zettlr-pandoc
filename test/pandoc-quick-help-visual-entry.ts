// Must be the first local import: it installs window.ipc, which the config
// store reads when the dialog makes it.
import "./document-collaboration-ipc-double";
import { createShortcutConfig } from "@common/commands/command-registry";
import { createPinia } from "pinia";
import PandocQuickHelp from "source/win-main/PandocQuickHelp.vue";
import { createApp, nextTick } from "vue";
import { documentCollaborationIpcDouble } from "./document-collaboration-ipc-double";
import editorConfig from "./fixtures/editor-config.json";

declare global {
  interface Window {
    captureReady: Promise<void>;
  }
}

async function mount(): Promise<void> {
  // The dialog shows the configured key of each command it names.
  const config = { ...editorConfig, shortcuts: createShortcutConfig() };
  documentCollaborationIpcDouble.setSendSyncResponder((channel, message) =>
    channel === "config-provider" && message?.command === "get-config" ? config : undefined,
  );
  createApp(PandocQuickHelp).use(createPinia()).mount("#app");
  await nextTick();
  await document.fonts.ready;
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

window.captureReady = mount();
