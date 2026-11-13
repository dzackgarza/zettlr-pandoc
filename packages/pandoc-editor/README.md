# Pandoc editor

CodeMirror's Pandoc editing surface, shared by Zettlr and embedded card fields.
Markdown remains the document. The package owns the parser, syntax styles,
themes, list indentation, source selection, and the standard live-preview
renderers for emphasis, headings, links, code, blockquotes, tasks, rules, and math.

Install this workspace package with the fork's `@lezer/markdown` dependency.
Use one CodeMirror and Lezer instance throughout the host.

```ts
import { markdownEditor } from "@dzack/pandoc-editor";
import "@dzack/pandoc-editor/editor.css";

const extensions = markdownEditor({
  math: { render: renderEquation },
});
```

`math.render` receives the equation, destination element, and display mode.
The host owns its MathJax runtime and macros. It may also supply a math context
menu. The package owns equation widgets and the interaction that reveals source.

Zettlr adds document services through `renderers`: citations, resolved references,
media, diagrams, tables, and Pandoc semantic containers. Its configuration field
provides `previewConfig`; its review field provides `previewSuppression` ranges.
These facets let the shared renderers follow host state without importing the
application. `theme` accepts an existing host theme; otherwise the editor uses
the Berlin light theme.

Subpath exports serve Zettlr's other editing surfaces. Pure delimiter helpers
remain independent of CodeMirror so server-side Markdown conversion can use them.
