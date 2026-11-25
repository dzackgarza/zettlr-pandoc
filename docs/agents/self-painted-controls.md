# 18. Controls that a surface paints itself

- **The window chrome paints every control.** `generic.css`
  (`common/vue/window/assets`) gives each `input`, `select`, `textarea` and
  `button` of a window the look of the platform. Its dark rules have the
  weight of two classes and two elements (`body.linux.dark button`), which is
  more than the rule of a component for its own control.
- **A surface that states the whole painting of its controls carries
  `self-painted-controls`.** The platform rules leave out each control in a
  subtree with that class, so the rules of the surface decide with any
  weight. The collaboration surfaces carry it: the Annotations view, the
  inline thread, the review bar, the review chunk, the create-annotation
  dialog and the two delete confirmations. The preview of an edit of several
  documents ([§28](multi-document-edits.md)) and the Fix All confirmation carry it too.
- **A portal is not in the subtree of its component.** A dialog that reka-ui
  puts on `body` carries the class on its own content element, and no rule
  for it is nested in the rule of the view that opens it.
- **A surface with the class states every property that the platform rules
  set** (background, colour, border, radius, padding, font) for each control
  in it. A control without such a rule has the look of the browser.
- **Proof:** `e2e/annotation-button-colours.spec.ts` (each control of each
  collaboration surface, in dark and in light mode, has the colour of its
  token and the same painting with and without the platform class),
  `e2e/fix-all.spec.ts` (the Fix All confirmation).
