/**
 * Assembled-app proof that the YAML front matter card keeps its own look
 * under the window's and the outer editor's stylesheets.
 *
 * The card holds a nested editor and a header <button> inside the outer
 * editor's DOM. In the dark Linux window the YAML is set in the editor code
 * font with no document margin around it, and the header carries the card's
 * colours, not the window's button chrome.
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, type Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  findEditorPage,
  preserveArtifacts,
  shutdown,
} from "./support/electron-app";

const DOCUMENT = `---
title: A note
tags: [one, two]
---

Body text.
`;

interface CardStyles {
  yamlFont: string;
  codeFont: string;
  scrollerPadding: string;
  scrollerBackground: string;
  headerBackground: string;
  headerRadius: string;
  buttonBackground: string;
}

describe("assembled app: the YAML front matter card", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-yaml-card-e2e-", {
      documentName: "note.md",
      documentContents: DOCUMENT,
      config: { darkMode: true, autoDarkMode: "off" },
    });
    fixtureRoot = fixture.root;
    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    // The card renders while the caret is outside the front matter.
    await page
      .locator(".cm-line", { hasText: "Body text." })
      .first()
      .click({ timeout: this.timeout() });
    await page
      .locator(".yaml-frontmatter-card .cm-line", { hasText: "title" })
      .waitFor({ state: "visible", timeout: this.timeout() });
  });

  after(async function () {
    if (page !== undefined) {
      screenshots.set(
        "yaml-frontmatter-card.png",
        await page.locator(".yaml-frontmatter-card").screenshot(),
      );
    }
    await shutdown(browser, appProcess);
    await preserveArtifacts(
      path.join(tmpdir(), "zettlr-yaml-card-e2e-latest"),
      fixtureRoot,
      getOutput(),
      rendererEvents,
      screenshots,
    );
    if (fixtureRoot !== undefined) {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
    assertCleanExit(getOutput());
  });

  it("sets the YAML in the code font without the document margin, under a header in the card colours", async function () {
    assert.ok(page !== undefined, "The editor window must be open");
    const styles: CardStyles = await page.evaluate(() => {
      const card = document.querySelector(".yaml-frontmatter-card");
      const scroller = card?.querySelector(".cm-scroller");
      const header = card?.querySelector(".yaml-frontmatter-header");
      const line = card?.querySelector(".cm-line");
      if (
        card === null ||
        card === undefined ||
        scroller == null ||
        header == null ||
        line == null
      ) {
        throw new Error("The front matter card is not rendered");
      }
      // Elements that resolve the code font and the window's button chrome
      // in the same place as the card.
      const codeProbe = document.createElement("span");
      codeProbe.style.fontFamily = "var(--zettlr-editor-code-font)";
      card.append(codeProbe);
      const button = document.createElement("button");
      document.body.append(button);
      const scrollerStyle = getComputedStyle(scroller);
      const headerStyle = getComputedStyle(header);
      const result = {
        yamlFont: getComputedStyle(line).fontFamily,
        codeFont: getComputedStyle(codeProbe).fontFamily,
        scrollerPadding: scrollerStyle.padding,
        scrollerBackground: scrollerStyle.backgroundColor,
        headerBackground: headerStyle.backgroundColor,
        headerRadius: headerStyle.borderRadius,
        buttonBackground: getComputedStyle(button).backgroundColor,
      };
      codeProbe.remove();
      button.remove();
      return result;
    });

    assert.equal(styles.yamlFont, styles.codeFont);
    assert.equal(styles.scrollerPadding, "0px");
    assert.equal(styles.scrollerBackground, "rgba(0, 0, 0, 0)");
    assert.notEqual(styles.headerBackground, styles.buttonBackground);
    assert.equal(styles.headerRadius, "0px");
  });
});
