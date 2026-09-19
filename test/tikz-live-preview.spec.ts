/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikZ live-preview scheduling proofs
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Locks the CPU/feedback-loop contract independently of Vue:
 *                  trailing debounce, one in-flight render, newest queued
 *                  source only, last-good retention across compile failures,
 *                  stale-diagnostic suppression, and explicit cache-bypassing
 *                  force renders.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import type { TikzRenderRequest, TikzRenderResult } from "source/app/util/tikz-render";
import {
  TikzLivePreviewController,
  type TikzLivePreviewState,
  type TikzLivePreviewTarget,
} from "source/common/modules/markdown-editor/tikz-live-preview";
import { contiguousSourceLineRanges } from "source/common/util/tikz-source-blocks";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';

function target(source: string, from = 10): TikzLivePreviewTarget {
  return {
    from,
    to: from + source.length,
    sourceFrom: from,
    sourceTo: from + source.length,
    source,
    sourceLineRanges: contiguousSourceLineRanges(source, from),
    kind: "raw",
    language: "tikzcd",
    docPath: "/notes/diagram.md",
  };
}

function success(name: string): TikzRenderResult {
  return {
    ok: true,
    html: `<div>${SVG}</div>`,
    svg: SVG,
    svgPath: `/cache/${name}.svg`,
    texFontSizePt: 10,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveResult!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveResult = resolve;
  });
  return { promise, resolve: resolveResult };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("TikZ live preview controller", function () {
  it("trailing-debounces rapid edits to the newest source", async function () {
    const requests: TikzRenderRequest[] = [];
    let state: TikzLivePreviewState | undefined;
    const controller = new TikzLivePreviewController(
      async (request) => {
        requests.push(request);
        return success("latest");
      },
      (next) => {
        state = next;
      },
      10,
    );

    controller.setTarget(target("A"));
    controller.setTarget(target("AB"));
    controller.setTarget(target("ABC"));
    await sleep(30);

    assert.deepStrictEqual(
      requests.map((request) => request.source),
      ["ABC"],
    );
    assert.strictEqual(state?.lastGood?.source, "ABC");
    assert.strictEqual(state?.pending, false);
    controller.dispose();
  });

  it("keeps one render in flight and replaces queued intermediate source with the newest edit", async function () {
    const requests: TikzRenderRequest[] = [];
    const first = deferred<TikzRenderResult>();
    const second = deferred<TikzRenderResult>();
    const controller = new TikzLivePreviewController(
      (request) => {
        requests.push(request);
        return requests.length === 1 ? first.promise : second.promise;
      },
      () => {},
      8,
    );

    controller.setTarget(target("A"));
    await sleep(20);
    assert.deepStrictEqual(
      requests.map((request) => request.source),
      ["A"],
    );

    controller.setTarget(target("AB"));
    await sleep(12); // AB becomes queued behind A.
    controller.setTarget(target("ABC")); // AB is immediately superseded.
    await sleep(12);
    assert.deepStrictEqual(
      requests.map((request) => request.source),
      ["A"],
      "no second compile starts while A is live",
    );

    first.resolve(success("a"));
    await sleep(5);
    assert.deepStrictEqual(
      requests.map((request) => request.source),
      ["A", "ABC"],
      "only the newest queued source starts next",
    );
    second.resolve(success("abc"));
    await sleep(5);
    controller.dispose();
  });

  it("keeps the last good figure when current source fails to compile", async function () {
    let state: TikzLivePreviewState | undefined;
    const controller = new TikzLivePreviewController(
      async (request) =>
        request.source === "good"
          ? success("good")
          : {
              ok: false,
              kind: "compile-error",
              errors: [{ line: 2, message: "Undefined control sequence.", sourceLine: "\\nope" }],
              log: "latex log",
            },
      (next) => {
        state = next;
      },
      5,
    );

    controller.setTarget(target("good"));
    await sleep(15);
    assert.strictEqual(state?.lastGood?.source, "good");

    controller.setTarget(target("broken"));
    await sleep(15);
    assert.strictEqual(
      state?.lastGood?.source,
      "good",
      "compile failure does not erase the visual reference",
    );
    assert.strictEqual(state?.failure?.kind, "compile-error");
    assert.strictEqual(state?.stale, true);
    controller.dispose();
  });

  it("does not flash an error from source that was edited away while compiling", async function () {
    const first = deferred<TikzRenderResult>();
    let calls = 0;
    let state: TikzLivePreviewState | undefined;
    const controller = new TikzLivePreviewController(
      async (request) => {
        calls++;
        if (calls === 1) {
          return await first.promise;
        }
        return success(request.source);
      },
      (next) => {
        state = next;
      },
      5,
    );

    controller.setTarget(target("broken"));
    await sleep(12);
    controller.setTarget(target("fixed"));
    await sleep(12);
    first.resolve({
      ok: false,
      kind: "compile-error",
      errors: [{ line: 1, message: "old error", sourceLine: "broken" }],
      log: "",
    });
    await sleep(8);
    assert.strictEqual(state?.failure, null, "the stale failure is not surfaced over fixed source");
    await sleep(8);
    assert.strictEqual(state?.lastGood?.source, "fixed");
    controller.dispose();
  });

  it("force render bypasses the cache even when source is unchanged", async function () {
    const requests: TikzRenderRequest[] = [];
    const controller = new TikzLivePreviewController(
      async (request) => {
        requests.push(request);
        return success(String(requests.length));
      },
      () => {},
      5,
    );

    controller.setTarget(target("same"));
    await sleep(15);
    controller.forceRender();
    await sleep(5);

    assert.deepStrictEqual(
      requests.map((request) => request.cachePolicy),
      ["use", "refresh"],
    );
    controller.dispose();
  });
});
