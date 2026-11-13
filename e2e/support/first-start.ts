/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        A first start of the app (e2e support)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A data directory without config.json is a first start:
 *                  the onboarding window opens before the main window. The
 *                  tutorial that a first start copies goes into the
 *                  documents folder of the fixture.
 *
 * END HEADER
 */

import { type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { delay, launchElectron, observeRenderer, waitForDevTools } from "./electron-app";

export interface FirstStart {
  appProcess: ChildProcess;
  browser: Browser;
  fixtureRoot: string;
  /** The folder of the tutorial that the first start copies. */
  tutorialDirectory: string;
  getOutput: () => string;
}

/**
 * Starts the app on an empty data directory. `environment` goes to the
 * development build too: a variable that webpack reads decides that build.
 */
export async function startFirstRun(
  prefix: string,
  rendererEvents: string[],
  timeoutMs: number,
  environment: NodeJS.ProcessEnv = {},
): Promise<FirstStart> {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), prefix));
  const configDirectory = path.join(fixtureRoot, "config");
  const documentsDirectory = path.join(fixtureRoot, "documents");
  const xdgConfigHome = path.join(fixtureRoot, "xdg-config");
  await mkdir(configDirectory);
  await mkdir(documentsDirectory);
  await mkdir(xdgConfigHome);
  await writeFile(
    path.join(xdgConfigHome, "user-dirs.dirs"),
    `XDG_DOCUMENTS_DIR="${documentsDirectory}"\n`,
    "utf8",
  );

  const appProcess = await launchElectron(configDirectory, {
    environment: { XDG_CONFIG_HOME: xdgConfigHome, ...environment },
  });
  let output = "";
  const appendOutput = (chunk: Buffer): void => {
    output = `${output}${chunk.toString()}`.slice(-200_000);
  };
  appProcess.stdout?.on("data", appendOutput);
  appProcess.stderr?.on("data", appendOutput);
  const devToolsUrl = await waitForDevTools(appProcess, () => output, timeoutMs);
  const browser = await chromium.connectOverCDP(devToolsUrl);
  for (const context of browser.contexts()) {
    context.pages().forEach((page) => observeRenderer(page, rendererEvents));
    context.on("page", (page) => observeRenderer(page, rendererEvents));
  }
  return {
    appProcess,
    browser,
    fixtureRoot,
    tutorialDirectory: path.join(documentsDirectory, "Zettlr Tutorial"),
    getOutput: () => output,
  };
}

/** The onboarding window, once it shows its progress bar. */
export async function onboardingPage(browser: Browser, timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().includes("/onboarding/"));
    if (page !== undefined) {
      await page.locator("#onboarding-progress span").first().waitFor({ state: "visible" });
      return page;
    }
    await delay(100);
  }
  throw new Error("The onboarding window did not open");
}

/**
 * Shows the page at `index` of the progress bar, whose heading is `heading`,
 * and waits until the page before it has left.
 */
export async function showOnboardingPage(
  page: Page,
  index: number,
  heading: string,
): Promise<void> {
  await page.locator("#onboarding-progress span").nth(index).click();
  await page.locator(".page h1", { hasText: heading }).waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelectorAll(".page").length === 1);
}
