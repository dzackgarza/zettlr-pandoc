/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        autoSaveChoices, UPDATE_CHECKS_BUILT_IN, updatesDisabledInfo
 * CVM-Role:        Utility
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The choices of settings that both the Preferences and the
 *                  first-start onboarding offer. Both windows read them here,
 *                  so the onboarding offers what the Preferences offer.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import type { ConfigOptions } from "source/app/service-providers/config/get-config-template";

/** The modes of `editor.autoSave`, with their labels. */
export function autoSaveChoices(): Record<ConfigOptions["editor"]["autoSave"], string> {
  return {
    off: trans("Never"),
    immediately: trans("Immediately"),
    delayed: trans("After a short delay"),
  };
}

/** Whether this build checks for updates; a packager can turn the check off. */
export const UPDATE_CHECKS_BUILT_IN = __UPDATES_DISABLED__ === "0";

/** The sentence that a build without update checks shows in place of its switches. */
export function updatesDisabledInfo(): string {
  return trans(
    "Updates for this binary of Zettlr have been disabled at build time. This is a choice made by the packager and is common when Zettlr is being distributed via package managers. In these cases, Zettlr will be updated through your package manager.",
  );
}
