/**
 * Mounts the production markdown editor with the visual-indent plugin and the
 * math renderer for isolated visual capture (issue #15). Follows the
 * editor-pandoc-div-visual-entry.ts pattern.
 *
 * The scenes exercise the line-level `text-indent` trap: visual-indent hangs
 * list markers and blockquote marks outside the text block via a negative
 * `text-indent` on the `.cm-line`, and every widget renderer that produces a
 * block container inherits it. The capture harness measures whether widget
 * content escapes its own box leftward.
 */

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";
import { softwrapVisualIndent } from "source/common/modules/markdown-editor/plugins/visual-indent";
import { renderEmphasis } from "source/common/modules/markdown-editor/renderers/render-emphasis";
import { renderMath } from "source/common/modules/markdown-editor/renderers/render-math";
import { renderMermaid } from "source/common/modules/markdown-editor/renderers/render-mermaid";
import { renderPandoc } from "source/common/modules/markdown-editor/renderers/render-pandoc-div-span";
import { renderTables } from "source/common/modules/markdown-editor/table-editor";
import {
  defaultDark,
  defaultLight,
  editorTheme,
} from "source/common/modules/markdown-editor/theme/editor";
import { configField } from "source/common/modules/markdown-editor/util/configuration";
import { initializeMathJax } from "source/common/util/mathtex-to-html";

declare global {
  interface Window {
    captureReady: Promise<void>;
  }
}

/** The issue #15 sample: leading, mid-item, and nested-depth inline math. */
const listMath = `# List math scenes

- $Y$ is a Halphen surface of index 2, so $abc$ holds;
- $C$ is the proper transform of the fiber $F$ containing $y_{0}=\\pi_{E}(E)$;
- the fiber $F$ is irreducible, and $y_{0}$ is its unique singular point.
  - nested: the discriminant $\\Delta = b^{2} - 4ac$ sits mid-item at depth two;
  - $\\frac{p}{q}$ leads a nested item with trailing text after it.

The trailing paragraph keeps the caret away from every list line.
`;

/** Blockquote and fenced-div regression scenes for the escape removals. */
const quoteDiv = `# Quote and div scenes

> A quoted line where $E_{8} \\oplus U$ appears mid-quote, so the quote mark
> hangs outside while the math must stay inside its own box.

::: theorem
Inside a fenced div, $\\pi_{E}$ renders in place.
:::

The trailing paragraph keeps the caret away from the scenes.
`;

/**
 * Table-editor and mermaid regression scenes for issue #7: both paths render
 * generated markup directly, and their output must survive unchanged.
 */
const tableMermaid = `# Table and mermaid scenes

| Lattice | Signature |
|---------|-----------|
| $U$     | $(1,1)$   |
| $E_{8}$ | $(8,0)$   |

\`\`\`mermaid
graph TD; A[Coble] --> B[Halphen]; B --> C[Enriques];
\`\`\`

The trailing paragraph keeps the caret away from the scenes.
`;

/**
 * The visual-indent plugin needs a measure round-trip before its line
 * decorations exist: the first render schedules measurements, and only a
 * later update pass can consume them. Pump empty transactions until an
 * indented line materializes, and fail loudly if none ever does — a capture
 * without the trap armed would prove nothing.
 */
async function waitForVisualIndent(view: EditorView, scene: string): Promise<void> {
  for (let round = 0; round < 60; round++) {
    if (scene === "quote-div") {
      // The fork hides blockquote marks, so quote lines measure a zero indent
      // and never arm the trap; this scene only needs its widgets mounted.
      if (document.querySelector(".preview-math") !== null) {
        return;
      }
    }
    if (scene === "table-mermaid") {
      // The regression scene needs the table widget mounted and mermaid's
      // async render landed; the indent trap is not its concern.
      if (document.querySelector("table") !== null && document.querySelector("svg") !== null) {
        return;
      }
    }
    const lines = Array.from(document.querySelectorAll<HTMLElement>(".cm-line"));
    if (lines.some((line) => getComputedStyle(line).textIndent.startsWith("-"))) {
      return;
    }
    view.dispatch({});
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  const dump = Array.from(document.querySelectorAll<HTMLElement>(".cm-line"))
    .map((line) =>
      JSON.stringify({ text: line.textContent?.slice(0, 40), style: line.getAttribute("style") }),
    )
    .join("\n");
  throw new Error(
    `visual-indent never produced an indented line; the capture is not exercising the trap\n${dump}`,
  );
}

async function mount(): Promise<void> {
  await initializeMathJax({});

  const scene = document.body.dataset.scene ?? "list-math";
  const dark = document.body.dataset.dark === "true";
  const doc =
    scene === "quote-div" ? quoteDiv : scene === "table-mermaid" ? tableMermaid : listMath;

  const state = EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [
      markdownParser(),
      configField,
      EditorView.lineWrapping,
      editorTheme,
      dark ? defaultDark : defaultLight,
      softwrapVisualIndent,
      renderPandoc,
      renderEmphasis,
      renderMath,
      renderMermaid,
      renderTables,
    ],
  });

  const host = document.querySelector<HTMLElement>("#editor");
  if (host === null) {
    throw new Error("Visual capture host is missing");
  }

  const view = new EditorView({ state, parent: host });
  view.focus();
  await document.fonts.ready;
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  await waitForVisualIndent(view, scene);
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

window.captureReady = mount();
