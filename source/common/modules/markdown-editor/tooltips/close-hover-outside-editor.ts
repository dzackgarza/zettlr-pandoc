/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        A hover that opens after the pointer left the editor
 * CVM-Role:        Extension
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The content of a hover tooltip can arrive late: a hover
 *                  asks the main process for a preview. CodeMirror closes an
 *                  open hover when the pointer leaves the editor, and it
 *                  drops a hover that is still waiting when the pointer
 *                  moves away inside the editor. It does not drop a waiting
 *                  hover when the pointer leaves the editor: the content
 *                  arrives, the tooltip opens, and no pointer event closes
 *                  it, because the pointer is elsewhere. This plugin closes
 *                  a hover that opens while the pointer is not over the
 *                  editor. A tooltip is inside the element of the editor,
 *                  so the pointer on a tooltip is over the editor.
 *
 * END HEADER
 */

import {
  closeHoverTooltips,
  type EditorView,
  hasHoverTooltips,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

export const closeHoverOutsideEditor = ViewPlugin.fromClass(
  class {
    /** The pointer is over the element of the editor (its text or one of its tooltips). */
    private pointerOverEditor = false;
    private readonly entered = (): void => {
      this.pointerOverEditor = true;
    };
    private readonly left = (): void => {
      this.pointerOverEditor = false;
    };

    constructor(private readonly view: EditorView) {
      // A pointer that moves over the editor is over it: the editor can be
      // made under a pointer that is at rest, and then no enter event comes.
      view.dom.addEventListener("mouseenter", this.entered);
      view.dom.addEventListener("mousemove", this.entered);
      view.dom.addEventListener("mouseleave", this.left);
    }

    update(update: ViewUpdate): void {
      const opened = hasHoverTooltips(update.state) && !hasHoverTooltips(update.startState);
      if (opened && !this.pointerOverEditor) {
        // An update is running; the close is an update of its own after it.
        queueMicrotask(() => {
          if (hasHoverTooltips(this.view.state) && !this.pointerOverEditor) {
            this.view.dispatch({ effects: closeHoverTooltips });
          }
        });
      }
    }

    destroy(): void {
      this.view.dom.removeEventListener("mouseenter", this.entered);
      this.view.dom.removeEventListener("mousemove", this.entered);
      this.view.dom.removeEventListener("mouseleave", this.left);
    }
  },
);
