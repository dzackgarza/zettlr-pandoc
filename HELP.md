# Authoring guide

Documents are Pandoc Markdown. This guide covers the structures that carry a
number and can be cross-referenced: tables, figures, equations, sections, code
listings and theorem-like blocks, plus citations.

## Which ID syntax a document uses

Two systems render cross-references here, and their IDs differ. Read
`crossReferences` from `GET /v1/documents/{documentId}`:

| `crossReferences` | Documents | Renderer | ID form |
|---|---|---|---|
| `pandoc-crossref` | everything outside a Quarto project, e.g. the dissertation | the `~/.pandoc` PDF recipes with pandoc-crossref | `#tbl:key` |
| `quarto` | files in a Quarto project, e.g. the `writing/.book` site | Quarto | `#tbl-key` |

Use one form per document. An ID in the other form does not resolve: it is
left as literal text or treated as a missing citation.

| Structure | pandoc-crossref ID | Quarto ID | Reference |
|---|---|---|---|
| Table | `{#tbl:key}` | `{#tbl-key}` | `@tbl:key` / `@tbl-key` |
| Figure | `{#fig:key}` | `{#fig-key}` | `@fig:key` / `@fig-key` |
| Equation | `{#eq:key}` | `{#eq-key}` | `@eq:key` / `@eq-key` |
| Section | `{#sec:key}` | `{#sec-key}` | `@sec:key` / `@sec-key` |
| Code listing | `{#lst:key}` | `{#lst-key}` | `@lst:key` / `@lst-key` |

Keys are lowercase words joined by hyphens: `tbl:coble-lattices`.

## Referring to a numbered block

Refer to every table, figure, equation, section, listing and theorem-like
block with a cross-reference, `@` and then its ID. Never refer to one with a
Markdown link to its ID.

| | Syntax |
|---|---|
| correct | `The comparison follows from @thm:tower-semitoroidal.` |
| wrong | `The comparison follows from [the tower theorem](#thm:tower-semitoroidal).` |

The two forms are resolved by different systems:

- A cross-reference (`@thm:key`) is resolved against every block the renderer
  sees. In a Quarto book, that is every chapter of the book. The output shows
  the number and links to the block: "Theorem 4.5".
- A link to a fragment (`[text](#thm:key)`) is a URL. The renderer keeps it
  unchanged, and the browser looks for the ID on the current page only. A
  Quarto book renders each chapter as its own page, so a link to a block in
  another chapter goes nowhere. The linter reports it as
  `link/invalid-fragment`.

To keep descriptive words, write them in the sentence and put the
cross-reference after them: `the tower criterion of @thm:tower-semitoroidal`.
A target that has no number, such as a table in the Quarto book, takes a link
that names its page: `[the lattice table](page.md#id)`.

## Attribute blocks

Every `{…}` after a heading, image, code fence, caption or `:::` fence is a
Pandoc attribute block. It holds three kinds of entry, separated by spaces:

| Entry | Syntax | Example |
|---|---|---|
| ID | `#` then the ID | `#thm:nikulin` |
| class | `.` then the class name, with no value | `.theorem` |
| key–value attribute | `key="value"`, with no leading `.` or `#` | `title="Nikulin"` |

A dot before a key–value attribute makes the whole block invalid:

```markdown
::: {.theorem #thm:nikulin .title="Nikulin"}
```

Pandoc then does not open the div. The fence line, the braces and the body
all render as plain paragraph text, in the editor and in the PDF. Write
`title="Nikulin"`.

## Tables

Write a pipe table, a blank line, then a caption paragraph that starts with
`:` and ends with the ID:

```markdown
| $n$ | Lattice $M$         | $\operatorname{rank} M$ |
|----:|:--------------------|------------------------:|
|   1 | $U \oplus E_8(2)$   |                      10 |
|   2 | $U(2) \oplus E_8(2)$ |                      10 |

: Lattices $M$ for $n$ boundary components. {#tbl:coble-lattices}
```

- Every table has a header row and a delimiter row. Colons in the delimiter row
  set alignment: `:---` left, `---:` right, `:---:` centred. Right-align numbers.
- The caption comes after the table, is one paragraph, and may contain math.
  Only the caption carries the ID; do not put an ID on the table rows.
- A pipe-table cell holds inline content only: text, math, citations. A cell
  that needs several paragraphs, a list or display math needs a grid table
  instead (Pandoc manual, "Tables").
- Refer to the table in the text: `@tbl:coble-lattices` renders as "Table 1".

## Figures

One image:

```markdown
![Caption, which may contain $math$.](figures/cusp.png){#fig:cusp width=80%}
```

A group of subfigures is a fenced div with its own ID. Each image has its own
ID, and the last paragraph is the group caption:

```markdown
::: {#fig:cusps}
![First cusp.](figures/cusp-a.png){#fig:cusp-a}

![Second cusp.](figures/cusp-b.png){#fig:cusp-b}

The two 0-dimensional cusps.
:::
```

In a Quarto document, use hyphen IDs and give the group a layout:
`::: {#fig-cusps layout-ncol=2}`.

TikZ figures use a `tikz` or `tikzcd` fence, or a raw `tikzpicture`
environment:

````markdown
```tikzcd
A \arrow[r, "f"] & B
```
````

A shared diagram file is included with `\input{diagrams/example.tikz}`.

## Equations

Put the ID after the closing `$$` of display math, on the same line:

```markdown
$$
L \cong U \oplus E_8(2)
$$ {#eq:l-decomposition}
```

Only display math can be numbered. Refer to it with `@eq:l-decomposition`.

## Sections

```markdown
## The Coble lattices {#sec:coble-lattices}
```

## Code listings

````markdown
```{#lst:gram .python caption="Gram matrix of the lattice."}
G = A * A.T
```
````

In a Quarto document the caption attribute is `lst-cap`:
`{#lst-gram .python lst-cap="Gram matrix of the lattice."}`.

## Theorem-like blocks

Theorem-like blocks use one syntax in every document, in the Quarto book and
in the pandoc-crossref papers. A block is a fenced div with the family's full
lowercase class and an ID with the family's prefix and a colon. The title is
optional:

```markdown
::: {.theorem #thm:nikulin title="Nikulin"}
An even hyperbolic 2-elementary lattice is determined up to isometry by
$(r, a, \delta)$.
:::

::: {.proof}
…
:::
```

Refer to it like a figure: `@thm:nikulin` ("Theorem 2.9"),
`[@thm:nikulin; @lem:gluing]`, `[-@thm:nikulin]` (number only). Proofs
(`.proof`, `.sketch`, `.solution`) are unnumbered and take no ID.

<!-- theorem-families -->

## Citations

| Form | Syntax |
|---|---|
| parenthetical | `[@Nikulin1980]` |
| in the sentence | `@Nikulin1980 shows …` |
| with a locator | `[@Nikulin1980, Thm. 4.3.2]` |
| with a prefix | `[see @Nikulin1980, §4]` |
| several | `[@Nikulin1980; @Conway1999]` |
| year only | `Nikulin [-@Nikulin1980] shows …` |

Keys must exist in the document's bibliography; the linter reports keys that
do not.

Keep citations and cross-references in separate brackets and join them with a
word: `@fig:cusp and [@FS86]`. In one bracket, or in two adjacent brackets,
the output reads as if the figure came from the cited work.

## Links to other documents

Link to another document of the workspace with a wikilink that names it, not
with a path: `[[cusp-correspondence|the cusp correspondence]]`. The editor
resolves the name in this order, ignoring case, and the first kind that matches
decides:

1. the document's `id` (Zettelkasten ID);
2. a path suffix: the file name without `.md`, or the end of its path
   relative to the workspace (`programs/cusp-correspondence`);
3. an entry of the document's YAML `aliases`;
4. the document's YAML `title`.

Write the shortest name that matches one document only; `GET /v1/workspace/files`
gives it for each file as `linkTarget`. A name survives a move
of either file; a relative path such as `[[../programs/cusp-correspondence.md]]`
does not. `#` and a heading after the name go to that heading:
`[[cusp-correspondence#Main result]]`.

The linter reports a name that matches no document
(`link/missing-wikilink-target`), a name that matches more than one
(`link/ambiguous-wikilink`) and a relative path (`link/relative-wikilink`),
with a fix to the shortest unique name.
