/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        SplashScreen entry point
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Controls the splash screen
 *
 * END HEADER
 */

import windowRegister from "@common/modules/window-register";
import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";

windowRegister()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  .then(() => createApp(App).use(createPinia()).mount("#app"))
  .catch((e) => console.error(e));
