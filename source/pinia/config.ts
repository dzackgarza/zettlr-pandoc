/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        useConfigStore
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This model manages the configuration
 *
 * END HEADER
 */

import type { ConfigJsonValue } from "@providers/config/config-validation";
import type { ConfigOptions, ConfigPath, ConfigValue } from "@providers/config/get-config-template";
import { defineStore } from "pinia";
import _ from "underscore";
import { ref } from "vue";

const ipcRenderer = window.ipc;

/**
 * Synchronously retrieves the configuration
 *
 * @return  {ConfigOptions}  The configuration
 */
function retrieveConfig(): ConfigOptions {
  return ipcRenderer.sendSync("config-provider", { command: "get-config" });
}

export const useConfigStore = defineStore("config", () => {
  const config = ref<ConfigOptions>(retrieveConfig());

  // Throttle the retrieve function to once per 50ms. We want the config to
  // update some values extremely frequently, and with the throttle in place, we
  // ensure that the (sometimes heavy) config updaters don't cause lag.
  const throttledRetrieve = _.throttle(() => {
    config.value = retrieveConfig();
  }, 50);

  // Listen to subsequent changes
  ipcRenderer.on("config-provider", (event, { command }) => {
    if (command === "update") {
      throttledRetrieve();
    }
  });

  function setConfigValue<P extends ConfigPath>(property: P, value: ConfigValue<P>): void {
    setConfigFromForm(property, value);
  }

  /**
   * Writes a value whose path the caller builds at runtime. A refusal is a
   * defect of the caller and throws.
   */
  function setConfigFromForm(property: string, value: ConfigJsonValue): void {
    const refusal = submitFormValue(property, value);
    if (refusal !== null) {
      throw new Error(refusal);
    }
  }

  /**
   * Writes a value that the author entered in a field of the preferences
   * form. The form builds its fields from a schema, so the type of a value
   * depends on the field at runtime. The main process is the authority: it
   * checks the path and the value against the rule of the setting, keeps the
   * old value for a refused one, and answers with the reason.
   *
   * @return  The reason of the refusal, or null for a saved value.
   */
  function submitFormValue(property: string, value: ConfigJsonValue): string | null {
    const refusal: string | null = ipcRenderer.sendSync("config-provider", {
      command: "set-config-single",
      payload: { key: property, val: value },
    });
    if (refusal !== null) {
      return refusal;
    }

    // Its update broadcast reaches this store asynchronously (and is throttled),
    // but callers such as sidebar reveal handlers may need the reactive mirror
    // to reflect the write before the next Vue render.
    config.value = retrieveConfig();
    return null;
  }

  return { config, setConfigValue, setConfigFromForm, submitFormValue };
});
