import PandocQuickHelp from "source/win-main/PandocQuickHelp.vue";
import { createApp, nextTick } from "vue";

declare global {
  interface Window {
    captureReady: Promise<void>;
  }
}

async function mount(): Promise<void> {
  createApp(PandocQuickHelp).mount("#app");
  await nextTick();
  await document.fonts.ready;
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

window.captureReady = mount();
