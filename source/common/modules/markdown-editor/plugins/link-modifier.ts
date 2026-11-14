/**
 * The Mod key of a link.
 *
 * A Mod-click on a chip follows its link. While the Mod key is down and the
 * pointer is in the editor, the editor has the class `cm-link-modifier`, so a
 * chip under the pointer can show the look of a link (#8).
 *
 * The model is `crosshairCursor` of @codemirror/view (dist/index.js, "Returns
 * an extension that turns the pointer cursor into a crosshair when a given
 * modifier key […] is held down"): a view plugin with the state of the key,
 * and an attribute facet that reads it. It differs in its listeners: a chip
 * is a widget that ignores mouse events, so the event observers of the view
 * do not get a pointer move over it, and the editor does not get a key while
 * another element has the focus.
 */

import { EditorView, ViewPlugin } from "@codemirror/view";

/** The label of the Mod key of this platform. */
export const MOD_KEY_LABEL = process.platform === "darwin" ? "Cmd" : "Ctrl";

function modIsDown(event: MouseEvent | KeyboardEvent): boolean {
  return process.platform === "darwin" ? event.metaKey : event.ctrlKey;
}

const linkModifierPlugin = ViewPlugin.fromClass(
  class {
    /** The Mod key is down and the pointer is in the editor. */
    held = false;
    private pointerInside = false;

    private readonly onPointerMove = (event: MouseEvent): void => {
      this.pointerInside = true;
      this.set(modIsDown(event));
    };

    private readonly onPointerLeave = (): void => {
      this.pointerInside = false;
      this.set(false);
    };

    private readonly onKey = (event: KeyboardEvent): void => {
      this.set(this.pointerInside && modIsDown(event));
    };

    private readonly onBlur = (): void => {
      this.set(false);
    };

    constructor(private readonly view: EditorView) {
      view.dom.addEventListener("mousemove", this.onPointerMove, true);
      view.dom.addEventListener("mouseleave", this.onPointerLeave);
      view.dom.ownerDocument.addEventListener("keydown", this.onKey, true);
      view.dom.ownerDocument.addEventListener("keyup", this.onKey, true);
      window.addEventListener("blur", this.onBlur);
    }

    destroy(): void {
      this.view.dom.removeEventListener("mousemove", this.onPointerMove, true);
      this.view.dom.removeEventListener("mouseleave", this.onPointerLeave);
      this.view.dom.ownerDocument.removeEventListener("keydown", this.onKey, true);
      this.view.dom.ownerDocument.removeEventListener("keyup", this.onKey, true);
      window.removeEventListener("blur", this.onBlur);
    }

    private set(held: boolean): void {
      if (this.held === held) {
        return;
      }
      this.held = held;
      this.view.update([]);
    }
  },
);

/**
 * Gives the editor the class `cm-link-modifier` while the Mod key is down
 * and the pointer is in the editor.
 */
export const linkModifier = [
  linkModifierPlugin,
  EditorView.editorAttributes.of((view) =>
    view.plugin(linkModifierPlugin)?.held === true ? { class: "cm-link-modifier" } : null,
  ),
];
