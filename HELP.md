In this Zettlr fork, write figures with Pandoc Markdown and `pandoc-crossref` attributes.

### 1. Standard Figures

Write figures as Markdown images followed by attribute braces:

```markdown
![Figure caption text](path/to/image.png){#fig:example-key}
```

Add optional size attributes inside the braces:

```markdown
![Figure caption text](path/to/image.png){#fig:example-key width=80%}
```

Key rules:
- The identifier must start with the `#fig:` prefix.
- The editor live preview renders the image and the caption via [`renderImages`](file:///home/dzack/gitclones/Zettlr-pandoc-mathjax/source/common/modules/markdown-editor/renderers/render-images.ts#L349-L404).
- Defined cross-reference conventions live in [pandoc-quick-reference.ts](file:///home/dzack/gitclones/Zettlr-pandoc-mathjax/source/common/util/pandoc-quick-reference.ts#L17-L25).

### 2. Subfigure Panels

Group multiple subfigures in a fenced div with a parent `#fig:` identifier:

```markdown
::: {#fig:comparison}
![Left subfigure caption](left.png){#fig:comp-left}

![Right subfigure caption](right.png){#fig:comp-right}

Overall caption text for the entire figure group.
:::
```

Key rules:
- Put the group identifier on the fenced div: `::: {#fig:group-id}`.
- Put individual `#fig:` identifiers on each nested image.
- Put the overall caption as the final text paragraph in the div.
- [`extractReferences`](file:///home/dzack/gitclones/Zettlr-pandoc-mathjax/source/common/pandoc-util/extract-references.ts#L249-L330) indexes both the group identifier and the subfigure identifiers.

### 3. TikZ Diagrams and Diagram Figures

You can write embedded TikZ diagrams in code blocks:

````markdown
```tikz
\draw (0,0) -- (1,1);
```
````

For commutative diagrams, use `tikzcd`:

````markdown
```tikzcd
A \arrow[r, "f"] & B
```
````

You can also use raw LaTeX blocks:

```latex
\begin{tikzpicture}
\draw (0,0) -- (1,1);
\end{tikzpicture}
```

To use a shared diagram file from the central figure store, use `\input`:

```latex
\input{diagrams/example.tikz}
```

The parser detects these blocks using [`tikzSourceBlocksInMarkdown`](file:///home/dzack/gitclones/Zettlr-pandoc-mathjax/source/common/util/tikz-source-blocks.ts#L133-L177) and resolves files through [`resolveCentralFiguresDirectory`](file:///home/dzack/gitclones/Zettlr-pandoc-mathjax/source/app/util/central-figures-store.ts#L59-L80).

### 4. Cross-Referencing Figures

Reference figures with the `@` symbol:

- Narrative citation: `@fig:example-key`
- Parenthetical citation: `[@fig:example-key]`
- Group citation: `[@fig:comp-left; @fig:comp-right]`
- Custom prefix: `[See @fig:example-key]`
- Suppress prefix: `[-@fig:example-key]`
