import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import markdownParser from "@dzack/pandoc-editor/parser/markdown-parser";
import { softwrapVisualIndent } from "@dzack/pandoc-editor/plugins/visual-indent";
import { renderEmphasis } from "@dzack/pandoc-editor/renderers/render-emphasis";
import { renderMath } from "@dzack/pandoc-editor/renderers/render-math";
import { defaultDark, defaultLight, editorTheme } from "@dzack/pandoc-editor/theme/editor";
import { renderMermaid } from "source/common/modules/markdown-editor/renderers/render-mermaid";
import { renderPandoc } from "source/common/modules/markdown-editor/renderers/render-pandoc-div-span";
import { renderTables } from "source/common/modules/markdown-editor/table-editor";
import { configField } from "source/common/modules/markdown-editor/util/configuration";
import { initializeMathJax } from "source/common/util/mathtex-to-html";

declare global {
  interface Window {
    captureReady: Promise<void>;
  }
}

const listMath = `# List math scenes

- $Y$ is a Halphen surface of index 2, so $abc$ holds;
- $C$ is the proper transform of the fiber $F$ containing $y_{0}=\\pi_{E}(E)$;
- the fiber $F$ is irreducible, and $y_{0}$ is its unique singular point.
  - nested: the discriminant $\\Delta = b^{2} - 4ac$ sits mid-item at depth two;
  - $\\frac{p}{q}$ leads a nested item with trailing text after it.

The trailing paragraph keeps the caret away from every list line.
`;

const quoteDiv = `# Quote and div scenes

> A quoted line where $E_{8} \\oplus U$ appears mid-quote, so the quote mark
> hangs outside while the math must stay inside its own box.

::: theorem
Inside a fenced div, $\\pi_{E}$ renders in place.
:::

The trailing paragraph keeps the caret away from the scenes.
`;

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

async function waitForVisualIndent(view: EditorView, scene: string): Promise<void> {
  for (let round = 0; round < 60; round++) {
    if (scene === "quote-div") {
      if (document.querySelector(".preview-math") !== null) {
        return;
      }
    }
    if (scene === "table-mermaid") {
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
