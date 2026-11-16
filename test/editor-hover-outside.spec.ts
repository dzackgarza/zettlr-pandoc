/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        A hover that opens after the pointer left the editor
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The content of a hover can arrive after the pointer left
 *                  the editor. CodeMirror then opens the tooltip, and no
 *                  pointer event closes it. `closeHoverOutsideEditor` closes
 *                  a hover that opens while the pointer is not over the
 *                  editor. The tests open a hover whose content arrives when
 *                  the test says so. They open it with `activateHover`: a
 *                  pointer has no position in a document without layout, so
 *                  the hover of a pointer cannot start here. What a pointer
 *                  does in CodeMirror (a hover that waits is not dropped on
 *                  `mouseleave`) is read from its source; the hosted run of
 *                  `e2e/chip-link-affordance.spec.ts` showed its effect.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { EditorState, type Extension } from "@codemirror/state";
import {
  activateHover,
  EditorView,
  hasHoverTooltips,
  hoverTooltip,
  type Tooltip,
} from "@codemirror/view";
import { closeHoverOutsideEditor } from "source/common/modules/markdown-editor/tooltips/close-hover-outside-editor";

/** A hover source whose content arrives when `arrive` is called. */
function lateHover(): { extension: Extension; arrive: () => void } {
  let resolve: (tooltip: Tooltip) => void = () => undefined;
  const extension = hoverTooltip(
    async (_view, pos) =>
      await new Promise<Tooltip>((done) => {
        resolve = done;
      }).then((tooltip) => ({ ...tooltip, pos })),
  );
  return {
    extension,
    arrive: () =>
      resolve({
        pos: 0,
        create: () => ({ dom: document.createElement("div") }),
      }),
  };
}

/** The tasks that the arrival of a hover and the plugin queue have run. */
async function settled(): Promise<void> {
  await new Promise((done) => setTimeout(done, 0));
}

describe("A hover that opens while the pointer is not over the editor", function () {
  const views: EditorView[] = [];

  function editor(plugins: Extension[]): { view: EditorView; hover: ReturnType<typeof lateHover> } {
    const hover = lateHover();
    const view = new EditorView({
      state: EditorState.create({
        doc: "See the genus of a lattice.",
        extensions: [hover.extension, ...plugins],
      }),
      parent: document.body,
    });
    views.push(view);
    return { view, hover };
  }

  afterEach(function () {
    for (const view of views.splice(0)) {
      view.destroy();
    }
  });

  it("stays open in an editor without the plugin", async function () {
    const { view, hover } = editor([]);
    view.dom.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    activateHover(view, 4, 1);
    view.dom.dispatchEvent(new MouseEvent("mouseleave"));

    hover.arrive();
    await settled();

    assert.equal(hasHoverTooltips(view.state), true);
  });

  it("is closed when its content arrives after the pointer left the editor", async function () {
    const { view, hover } = editor([closeHoverOutsideEditor]);
    view.dom.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    activateHover(view, 4, 1);
    view.dom.dispatchEvent(new MouseEvent("mouseleave"));

    hover.arrive();
    await settled();

    assert.equal(hasHoverTooltips(view.state), false);
  });

  it("stays open when its content arrives while the pointer is over the editor", async function () {
    const { view, hover } = editor([closeHoverOutsideEditor]);
    view.dom.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    activateHover(view, 4, 1);

    hover.arrive();
    await settled();

    assert.equal(hasHoverTooltips(view.state), true);
  });

  it("stays open when the pointer comes back before its content arrives", async function () {
    const { view, hover } = editor([closeHoverOutsideEditor]);
    view.dom.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    activateHover(view, 4, 1);
    view.dom.dispatchEvent(new MouseEvent("mouseleave"));
    view.dom.dispatchEvent(new MouseEvent("mouseenter"));

    hover.arrive();
    await settled();

    assert.equal(hasHoverTooltips(view.state), true);
  });
});
