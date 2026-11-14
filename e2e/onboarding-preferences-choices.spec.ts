/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The choices of the onboarding and of the Preferences (e2e)
 *
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The first-start onboarding sets some settings that the
 *                  Preferences also set, and it offers the same choices
 *                  under the same rules (#204): the three autosave modes,
 *                  beta releases only while the app checks for updates, and
 *                  no update switch in a build without update checks.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ConfigOptions } from "@providers/config/get-config-template";
import type { Page } from "playwright";
import {
  assertCleanExit,
  clickToClose,
  findEditorPage,
  preserveArtifacts,
  shutdown,
  startDeadline,
  waitForApplicationBoot,
} from "./support/electron-app";
import {
  type FirstStart,
  onboardingPage,
  showOnboardingPage,
  startFirstRun,
} from "./support/first-start";

const UPDATES_PAGE = 2;
const WRITING_MARKDOWN_PAGE = 4;

function readConfig(page: Page): Promise<ConfigOptions> {
  return page.evaluate(() =>
    window.ipc.sendSync<ConfigOptions>("config-provider", { command: "get-config" }),
  );
}

/** A screenshot after the transitions of the controls (0.4 s) end. */
async function settledScreenshot(page: Page): Promise<Buffer> {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== "running"),
  );
  return await page.screenshot();
}

function describeFirstStart(
  title: string,
  name: string,
  buildEnvironment: NodeJS.ProcessEnv | undefined,
  cases: (start: () => FirstStart, screenshots: Map<string, Buffer>) => void,
): void {
  describe(title, function () {
    let start: FirstStart | undefined;
    const rendererEvents: string[] = [];
    const screenshots = new Map<string, Buffer>();

    before(async function () {
      // A start of a build of its own compiles webpack: the hook gives the
      // start its whole deadline, and the error of the start ends the hook.
      this.timeout(startDeadline({ buildEnvironment }) + 30_000);
      start = await startFirstRun(`zettlr-${name}-e2e-`, rendererEvents, buildEnvironment);
    });

    after(async function () {
      // A start that failed in the before hook left no app and no output.
      if (start === undefined) {
        return;
      }
      // The main window opens when the onboarding closes; the app quits
      // through it.
      const page = await onboardingPage(start.browser, this.timeout());
      await clickToClose(page, page.locator('nav button:has-text("Skip")'));
      await waitForApplicationBoot(start.appProcess, start.getOutput, this.timeout());
      await findEditorPage(start.browser, this.timeout());
      await shutdown(start.browser, start.appProcess);
      const output = start.getOutput();
      await preserveArtifacts(
        path.join(tmpdir(), `zettlr-${name}-e2e-latest`),
        start.fixtureRoot,
        output,
        rendererEvents,
        screenshots,
      );
      await rm(start.fixtureRoot, { recursive: true, force: true });
      assertCleanExit(output);
    });

    cases(() => {
      assert.ok(start !== undefined, "the first start ran");
      return start;
    }, screenshots);
  });
}

describeFirstStart(
  "assembled app: the onboarding offers the choices of the Preferences",
  "onboarding-choices",
  undefined,
  (start, screenshots) => {
    it("offers beta releases only while the app checks for updates", async function () {
      const page = await onboardingPage(start().browser, this.timeout());
      await showOnboardingPage(page, UPDATES_PAGE, "Staying Up To Date");
      const betas = page.locator('input[name="check-beta"]');
      assert.equal(await betas.isDisabled(), false, "the app checks for updates at a first start");
      await page.locator('label[for="form-input-check-updates"]').first().click();
      assert.equal((await readConfig(page)).system.checkForUpdates, false);
      assert.equal(await page.locator('input[name="check-updates"]').isChecked(), false);
      screenshots.set("onboarding-updates-off.png", await settledScreenshot(page));
      assert.equal(
        await betas.isDisabled(),
        true,
        "without update checks, the beta switch is disabled, as in the Preferences",
      );
    });

    it("offers the three autosave modes", async function () {
      const page = await onboardingPage(start().browser, this.timeout());
      await showOnboardingPage(page, WRITING_MARKDOWN_PAGE, "Writing Markdown");
      const autosave = page.locator(".radio-group-label");
      assert.deepEqual(
        (await autosave.allInnerTexts()).map((text) => text.trim()),
        ["Never", "Immediately", "After a short delay"],
      );
      await autosave.filter({ hasText: "After a short delay" }).click();
      assert.equal((await readConfig(page)).editor.autoSave, "delayed");
      assert.equal(
        await page.locator('input[name="autosave"]:checked').getAttribute("value"),
        "delayed",
      );
      screenshots.set("onboarding-autosave-delayed.png", await settledScreenshot(page));
    });
  },
);

describeFirstStart(
  "assembled app: the onboarding of a build without update checks",
  "onboarding-no-updates",
  { ZETTLR_DISABLE_UPDATE_CHECK: "1" },
  (start, screenshots) => {
    it("shows that the build checks for no updates and offers no switch", async function () {
      const page = await onboardingPage(start().browser, this.timeout());
      await showOnboardingPage(page, UPDATES_PAGE, "Staying Up To Date");
      screenshots.set("onboarding-updates-disabled.png", await settledScreenshot(page));
      assert.equal(await page.locator(".page .switch-group").count(), 0);
      assert.match(
        await page.locator(".page").innerText(),
        /Updates for this binary of Zettlr have been disabled at build time\./,
      );
    });
  },
);
