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

### pandoc-crossref documents

A theorem-like block is a fenced div with the family's class and an ID with
the family's prefix. The title is optional:

```markdown
::: {.theorem #thm:nikulin title="Nikulin"}
An even hyperbolic 2-elementary lattice is determined up to isometry by
$(r, a, \delta)$.
:::

::: {.proof}
…
:::
```

Refer to it like a figure: `@thm:nikulin`, `[@thm:nikulin; @lem:gluing]`,
`[-@thm:nikulin]` (number only). Proofs (`.proof`, `.sketch`, `.solution`) are
unnumbered and take no ID.

<!-- theorem-families -->

### Quarto book (`writing/.book`)

The book numbers blocks with the `custom-numbered-blocks` filter. The class is
capitalised, the ID keeps a colon (Quarto reserves `thm-`, `lem-`, `def-` and
the other hyphen prefixes for its own theorems), and an optional title is the
first heading inside the block:

```markdown
::: {.Theorem #thm:nikulin}
### Nikulin
An even hyperbolic 2-elementary lattice is determined up to isometry by
$(r, a, \delta)$.
:::
```

Refer to it with `\ref{thm:nikulin}` (number only) or `\longref{thm:nikulin}`
("Theorem 2.9").

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
