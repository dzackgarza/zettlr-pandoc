/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app TikZ live-preview journey
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Drives the real MainEditor/CodeMirror/TikZ IPC boundary:
 *                  entering a TikZ block opens the compiled preview, which
 *                  embeds no editor and offers Visual TikZ Editor; a real
 *                  TeX error leaves the last-good SVG visible, correcting the
 *                  source recovers, and the explicit rerender completes.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { type Browser, type Page } from "playwright";
import { attach, createFixture, findEditorPage, shutdown } from "./support/electron-app";

const DOCUMENT = String.raw`# TikZ live integration

\begin{tikzcd}
A \arrow[r, "f"] & B
\end{tikzcd}

\begin{tikzpicture}[
  box/.style={rectangle, draw, minimum width=2.5cm, minimum height=0.8cm},
  dot/.style={circle, draw, minimum size=0.8cm}
]
\node[dot] (eta) at (0,0) {$\eta$};
\node[box] (A1) at (4,1) {$A_1$};
\draw[->] (eta.east) -- (A1.west);
\end{tikzpicture}
`;

describe("TikZ microlocal live preview in the assembled app", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];

  before(async function () {
    const fixture = await createFixture("zettlr-tikz-live-e2e-", {
      documentName: "tikz-live.md",
      documentContents: DOCUMENT,
    });
    fixtureRoot = fixture.root;
    const app = await attach(fixture.configDirectory, rendererEvents);
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(browser, this.timeout());
  });

  after(async function () {
    await shutdown(browser, appProcess);
    if (fixtureRoot !== undefined) {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
    assert.doesNotMatch(
      getOutput(),
      /(?:^|\n).*FATAL:|Uncaught exception/,
      "the assembled app must not terminate through a fatal/uncaught error",
    );
  });

  it("retains the last-good figure through a compile failure and recovers", async function () {
    assert.ok(page !== undefined, "the main editor page must be attached");

    const entered = await page.evaluate(`(() => {
      const view = document.querySelector('.cm-content')?.cmTile?.root?.view
      if (!view) return false
      const pos = view.state.doc.toString().indexOf('A \\\\arrow') + 2
      if (pos < 2) return false
      view.dispatch({ selection: { anchor: pos } })
      view.focus()
      return true
    })()`);
    assert.strictEqual(
      entered,
      true,
      "the production CodeMirror view must expose the authored TikZ body",
    );

    const preview = page.locator(".tikz-live-preview");
    await preview.waitFor({ state: "visible", timeout: 20_000 });
    // The pane has one view: the figure that TeX compiled. The visual editors
    // are a separate application, which the pane starts.
    assert.strictEqual(
      await preview.getByRole("group", { name: "Diagram view" }).count(),
      0,
      "the pane offers no choice of editor",
    );
    assert.strictEqual(await page.locator("iframe").count(), 0, "the window embeds no editor page");
    assert.ok(
      await preview.getByRole("button", { name: "Edit in Visual TikZ Editor" }).isVisible(),
      "the pane starts Visual TikZ Editor on the active diagram",
    );
    assert.ok(
      (await page.locator(".cm-content").innerText()).includes("\\begin{tikzcd}"),
      "the ordinary CodeMirror source remains the editing surface beside the preview",
    );
    await preview
      .locator(".tikz-live-preview-figure .viewer-canvas img")
      .waitFor({ state: "visible", timeout: 60_000 });
    await page.waitForFunction(
      () =>
        document.querySelector(".tikz-live-preview-status")?.textContent?.includes("Up to date") ===
        true,
      undefined,
      { timeout: 60_000 },
    );

    await page.waitForFunction(
      () => {
        const canvas = document.querySelector(".tikz-live-preview-figure .viewer-canvas");
        const image = canvas?.querySelector("img");
        if (!(canvas instanceof HTMLElement) || !(image instanceof HTMLImageElement)) return false;
        const canvasRect = canvas.getBoundingClientRect();
        const imageRect = image.getBoundingClientRect();
        return (
          Math.max(imageRect.width / canvasRect.width, imageRect.height / canvasRect.height) >= 0.8
        );
      },
      undefined,
      { timeout: 20_000 },
    );
    const initialFit = (await page.evaluate(() => {
      const canvas = document.querySelector(".tikz-live-preview-figure .viewer-canvas");
      const image = canvas?.querySelector("img");
      if (!(canvas instanceof HTMLElement) || !(image instanceof HTMLImageElement)) return null;
      const canvasRect = canvas.getBoundingClientRect();
      const imageRect = image.getBoundingClientRect();
      return {
        widthShare: imageRect.width / canvasRect.width,
        heightShare: imageRect.height / canvasRect.height,
      };
    })) as { widthShare: number; heightShare: number } | null;
    assert.ok(
      initialFit !== null && Math.max(initialFit.widthShare, initialFit.heightShare) >= 0.8,
      `the dedicated viewer must default to a useful contain fit rather than the SVG's tiny intrinsic size: ${JSON.stringify(initialFit)}`,
    );

    const inlineViewer = preview.locator(".tikz-live-preview-figure .tikz-workbench-viewerjs");
    await inlineViewer.locator(".viewer-canvas").click({ position: { x: 8, y: 8 } });
    assert.strictEqual(
      await page.locator(".tikz-workbench-viewerjs.viewer-fixed").count(),
      0,
      "the RHS canvas has no competing Viewer.js modal path",
    );
    assert.strictEqual(
      await inlineViewer.locator(".viewer-button").isVisible(),
      false,
      "Viewer.js does not expose a second visible fullscreen control inside the unified RHS pane",
    );

    // Fullscreen belongs to the pane, not to either preview backend. Mark the
    // Viewer.js node, promote the pane, and require the same viewer instance to
    // remain mounted while it refits to the larger canvas.
    await page.evaluate(() => {
      const viewer = document.querySelector(".tikz-live-preview-figure .tikz-workbench-viewerjs");
      if (!(viewer instanceof HTMLElement)) throw new Error("inline Viewer.js surface missing");
      viewer.dataset.e2eViewerIdentity = "editing-instance";
    });
    await preview.locator(".tikz-live-preview-expand").click();
    await page.waitForFunction(
      () => document.querySelector(".tikz-live-preview")?.classList.contains("fullscreen") === true,
    );
    await page.waitForFunction(
      () => {
        const canvas = document.querySelector(
          ".tikz-live-preview.fullscreen .tikz-live-preview-figure .viewer-canvas",
        );
        const image = canvas?.querySelector("img");
        if (!(canvas instanceof HTMLElement) || !(image instanceof HTMLImageElement)) return false;
        const canvasRect = canvas.getBoundingClientRect();
        const imageRect = image.getBoundingClientRect();
        return (
          Math.max(imageRect.width / canvasRect.width, imageRect.height / canvasRect.height) >= 0.8
        );
      },
      undefined,
      { timeout: 20_000 },
    );
    assert.strictEqual(
      await inlineViewer.getAttribute("data-e2e-viewer-identity"),
      "editing-instance",
      "fullscreen promotion preserves the exact RHS Viewer.js instance",
    );
    assert.strictEqual(
      await page.locator(".tikz-workbench-viewerjs").count(),
      1,
      "fullscreen does not create a second viewer",
    );
    assert.strictEqual(
      await inlineViewer.locator('input[type="number"]').count(),
      0,
      "the removed numeric zoom field remains absent",
    );
    await preview.locator(".tikz-live-preview-expand").click();
    await page.waitForFunction(
      () => document.querySelector(".tikz-live-preview")?.classList.contains("fullscreen") !== true,
    );

    // The mature viewer owns touch/pinch. Drive two real pointer identities
    // apart and require the displayed image to grow, which the old mouse-only
    // hand-written sidecar could not do.
    const pinch = (await page.evaluate(`(async () => {
      const canvas = document.querySelector('.tikz-live-preview-figure .viewer-canvas')
      const image = canvas?.querySelector('img')
      if (!(canvas instanceof HTMLElement) || !(image instanceof HTMLImageElement)) return null
      const before = image.getBoundingClientRect().width
      canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 120, clientY: 120 }))
      canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 2, pointerType: 'touch', isPrimary: false, clientX: 200, clientY: 120 }))
      canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 2, pointerType: 'touch', isPrimary: false, clientX: 280, clientY: 120 }))
      canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 2, pointerType: 'touch', isPrimary: false, clientX: 280, clientY: 120 }))
      canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 120, clientY: 120 }))
      await new Promise(resolve => setTimeout(resolve, 50))
      return { before, after: image.getBoundingClientRect().width }
    })()`)) as { before: number; after: number } | null;
    assert.ok(
      pinch !== null && pinch.after > pinch.before,
      `touch pinch must zoom the shared viewer: ${JSON.stringify(pinch)}`,
    );

    // A successful source edit must replace only the SVG, not the viewer or
    // the user's viewport. Sample every painted frame while the real TeX render
    // runs so a transient shrink-to-natural-size/rezoom cycle is a failure too.
    const stableBefore = await page.evaluate(() => {
      const viewer = document.querySelector(".tikz-live-preview-figure .tikz-workbench-viewerjs");
      const canvas = viewer?.querySelector(".viewer-canvas");
      const image = canvas?.querySelector("img");
      if (
        !(viewer instanceof HTMLElement) ||
        !(canvas instanceof HTMLElement) ||
        !(image instanceof HTMLImageElement)
      )
        return null;
      viewer.dataset.e2eStableEditIdentity = "same-viewer-across-compile";
      const width = Number.parseFloat(image.style.width);
      const height = Number.parseFloat(image.style.height);
      const x = Number.parseFloat(image.style.marginLeft);
      const y = Number.parseFloat(image.style.marginTop);
      const canvasRect = canvas.getBoundingClientRect();
      const footer = viewer.querySelector(".viewer-footer");
      const footerHeight =
        footer instanceof HTMLElement ? footer.getBoundingClientRect().height : 0;
      const contentHeight = Math.max(0, canvasRect.height - footerHeight);
      return {
        ratio: width / image.naturalWidth,
        centerOffsetX: x + width / 2 - canvasRect.width / 2,
        centerOffsetY: y + height / 2 - contentHeight / 2,
      };
    });
    assert.ok(
      stableBefore !== null && Number.isFinite(stableBefore.ratio),
      "a stable zoomed viewer state must exist before editing",
    );
    const previousSvgPath = await preview
      .locator(".tikz-live-preview-figure")
      .getAttribute("data-svg-path");
    assert.ok(previousSvgPath !== null, "the live viewer must name its current rendered SVG");

    const zoomSampler = await page.evaluateHandle(() => {
      const samples: number[] = [];
      const sampler = {
        sampling: true,
        samples,
        // A method, not a named arrow: the test transpiler wraps named
        // functions in a helper the page does not define.
        tick(): void {
          const image = document.querySelector(".tikz-live-preview-figure .viewer-canvas img");
          if (image instanceof HTMLImageElement && image.naturalWidth > 0) {
            const width = Number.parseFloat(image.style.width);
            if (Number.isFinite(width)) sampler.samples.push(width / image.naturalWidth);
          }
          if (sampler.sampling) requestAnimationFrame(() => sampler.tick());
        },
      };
      requestAnimationFrame(() => sampler.tick());
      return sampler;
    });

    const validEdit = await page.evaluate(`(() => {
      const view = document.querySelector('.cm-content')?.cmTile?.root?.view
      if (!view) return false
      const source = view.state.doc.toString()
      const at = source.indexOf('"f"') + 2
      if (at < 2) return false
      view.dispatch({ changes: { from: at, insert: '_1' }, selection: { anchor: at + 2 } })
      view.focus()
      return true
    })()`);
    assert.strictEqual(validEdit, true, "the valid TikZ edit must land through CodeMirror");
    await preview
      .locator(".tikz-live-preview-spinner")
      .waitFor({ state: "visible", timeout: 20_000 });
    assert.ok(
      await preview.locator(".tikz-live-preview-figure .viewer-canvas img").isVisible(),
      "recompiling keeps the last-good figure visible behind the busy indicator",
    );
    assert.match(
      await preview.locator(".tikz-live-preview-status").innerText(),
      /Updating|Rendering/,
      "the spinner accompanies an explicit rendering status",
    );
    await page.waitForFunction(
      (previous) =>
        document.querySelector(".tikz-live-preview-figure")?.getAttribute("data-svg-path") !==
        previous,
      previousSvgPath,
      { timeout: 60_000 },
    );
    await page.waitForFunction(
      () =>
        document.querySelector(".tikz-live-preview-status")?.textContent?.includes("Up to date") ===
        true,
      undefined,
      { timeout: 60_000 },
    );
    assert.strictEqual(
      await preview.locator(".tikz-live-preview-spinner").count(),
      0,
      "the busy indicator disappears as soon as the recompile finishes",
    );
    const stableAfter = await page.evaluate((sampler) => {
      sampler.sampling = false;
      const viewer = document.querySelector(".tikz-live-preview-figure .tikz-workbench-viewerjs");
      const canvas = viewer?.querySelector(".viewer-canvas");
      const image = canvas?.querySelector("img");
      if (
        !(viewer instanceof HTMLElement) ||
        !(canvas instanceof HTMLElement) ||
        !(image instanceof HTMLImageElement)
      )
        return null;
      const width = Number.parseFloat(image.style.width);
      const height = Number.parseFloat(image.style.height);
      const x = Number.parseFloat(image.style.marginLeft);
      const y = Number.parseFloat(image.style.marginTop);
      const canvasRect = canvas.getBoundingClientRect();
      const footer = viewer.querySelector(".viewer-footer");
      const footerHeight =
        footer instanceof HTMLElement ? footer.getBoundingClientRect().height : 0;
      const contentHeight = Math.max(0, canvasRect.height - footerHeight);
      return {
        identity: viewer.dataset.e2eStableEditIdentity,
        ratio: width / image.naturalWidth,
        centerOffsetX: x + width / 2 - canvasRect.width / 2,
        centerOffsetY: y + height / 2 - contentHeight / 2,
        samples: sampler.samples,
      };
    }, zoomSampler);
    assert.ok(stableAfter !== null, "the updated TikZ viewer must remain mounted");
    assert.strictEqual(
      stableAfter.identity,
      "same-viewer-across-compile",
      "a successful compile updates the existing Viewer.js instance",
    );
    assert.ok(
      Math.abs(stableAfter.ratio - stableBefore.ratio) < 0.02,
      `zoom ratio survives a valid edit: before=${stableBefore.ratio}, after=${stableAfter.ratio}`,
    );
    assert.ok(
      Math.abs(stableAfter.centerOffsetX - stableBefore.centerOffsetX) < 2,
      "horizontal pan survives a valid edit",
    );
    assert.ok(
      Math.abs(stableAfter.centerOffsetY - stableBefore.centerOffsetY) < 2,
      "vertical pan survives a valid edit",
    );
    assert.ok(stableAfter.samples.length >= 2, "the update was observed across painted frames");
    assert.ok(
      stableAfter.samples.every(
        (ratio) => Math.abs(ratio - stableBefore.ratio) < Math.max(0.05, stableBefore.ratio * 0.08),
      ),
      `no painted frame may shrink and rezoom during a source update: ${JSON.stringify(stableAfter.samples)}`,
    );

    const inserted = String.raw` \thisMacroDoesNotExist`;
    const edit = (await page.evaluate(`(() => {
      const inserted = ${JSON.stringify(inserted)}
      const view = document.querySelector('.cm-content')?.cmTile?.root?.view
      if (!view) return null
      const at = view.state.doc.toString().indexOf('& B') + 3
      if (at < 3) return null
      view.dispatch({
        changes: { from: at, insert: inserted },
        selection: { anchor: at + inserted.length }
      })
      view.focus()
      return { at, length: inserted.length }
    })()`)) as { at: number; length: number } | null;
    assert.ok(edit !== null, "the invalid edit must land through the production CodeMirror view");

    await preview
      .locator(".tikz-live-preview-error")
      .waitFor({ state: "visible", timeout: 60_000 });
    assert.ok(
      await preview.locator(".tikz-live-preview-figure .viewer-canvas img").isVisible(),
      "the previous successful SVG remains visible while the current source is invalid",
    );
    assert.match(
      await preview.locator(".tikz-live-preview-status").innerText(),
      /Last good render/,
    );
    assert.match(
      await preview.locator(".tikz-live-preview-error").innerText(),
      /Undefined control sequence|failed to compile/,
    );

    await page.evaluate(`(() => {
      const at = ${edit.at}
      const length = ${edit.length}
      const view = document.querySelector('.cm-content')?.cmTile?.root?.view
      if (!view) throw new Error('CodeMirror view disappeared')
      view.dispatch({
        changes: { from: at, to: at + length, insert: '' },
        selection: { anchor: at }
      })
      view.focus()
    })()`);
    await page.waitForFunction(
      () =>
        document.querySelector(".tikz-live-preview-status")?.textContent?.includes("Up to date") ===
        true,
      undefined,
      { timeout: 60_000 },
    );
    assert.strictEqual(
      await preview.locator(".tikz-live-preview-error").count(),
      0,
      "the compile diagnostic clears after the corrected source renders",
    );

    await preview.locator(".tikz-live-preview-refresh").click();
    await page.waitForFunction(
      () =>
        document.querySelector(".tikz-live-preview-status")?.textContent?.includes("Up to date") ===
        true,
      undefined,
      { timeout: 60_000 },
    );
    assert.deepStrictEqual(
      rendererEvents,
      [],
      `the renderer emitted errors: ${JSON.stringify(rendererEvents)}`,
    );
  });
});
