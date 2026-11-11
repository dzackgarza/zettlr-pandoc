/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Slide of the panes of a window
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Plays the slide of a side pane that the author shows or
 *                  hides. The splitter gives each pane the size of the end at
 *                  once, and the slide is played from the sizes of before to
 *                  those sizes (FLIP,
 *                  https://aerotwist.com/blog/flip-your-animations/). The
 *                  editor therefore wraps its document one time, at the width
 *                  of the end: for the time of the slide the content of the
 *                  editor pane keeps that width, with the edge that does not
 *                  move fixed, and the pane clips it. A slide that eases the
 *                  size of the editor pane with its content in it wraps the
 *                  document again for each frame (#126).
 *
 * END HEADER
 */

import { nextTick, type Ref } from "vue";

export const PANE_ANIMATION_MS = 180;

/** The width and the fixed edge of the content of the editor pane. */
export interface EditorSlide {
  width: string;
  anchor: "left" | "right";
}

export const EDITOR_FILLS_ITS_PANE: EditorSlide = { width: "100%", anchor: "left" };

/** What the group of panes binds: the class `animating` and the editor frame. */
export interface PaneSlideState {
  animating: Ref<boolean>;
  editorSlide: Ref<EditorSlide>;
}

/**
 * Gives the function that slides the panes of one group.
 *
 * @param   {PaneSlideState}  state  The state that the template of the group binds
 *
 * @return  {Function}               Slides the panes of `group`. `anchor` is
 *                                   the edge of the editor that does not move,
 *                                   and `applySizes` gives each pane its size
 *                                   of the end in the splitter.
 */
export function paneSlide(
  state: PaneSlideState,
): (group: HTMLElement, anchor: EditorSlide["anchor"], applySizes: () => void) => Promise<void> {
  let slides: Animation[] = [];
  return async (group, anchor, applySizes) => {
    const panes = Array.from(group.querySelectorAll<HTMLElement>(":scope > .main-pane"));
    const editorPane = panes.find((pane) => pane.dataset.pane === "editor");
    if (editorPane === undefined) {
      throw new Error("The group of panes has no editor pane");
    }
    // A slide that still runs is at the sizes of one of its frames; the new
    // slide starts from them.
    const sizesBefore = panes.map((pane) => getComputedStyle(pane).flexGrow);
    for (const slide of slides) {
      slide.cancel();
    }
    state.animating.value = true;
    applySizes();
    await nextTick();
    state.editorSlide.value = {
      width: `${editorPane.getBoundingClientRect().width}px`,
      anchor,
    };
    slides = panes.map((pane, index) =>
      pane.animate(
        [{ flexGrow: sizesBefore[index] }, { flexGrow: getComputedStyle(pane).flexGrow }],
        { duration: PANE_ANIMATION_MS, easing: "ease" },
      ),
    );
    // A slide that a later toggle cancelled does not finish; the later slide
    // ends the state.
    slides[0].onfinish = () => {
      state.animating.value = false;
      state.editorSlide.value = EDITOR_FILLS_ITS_PANE;
      slides = [];
    };
  };
}
