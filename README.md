# zettlr-pandoc

A fork of [Zettlr](https://github.com/Zettlr/Zettlr) that swaps its math rendering engine for MathJax and adds user-configurable TeX macros shared between the editor and Pandoc export.

Everything not described here is unchanged from upstream Zettlr.
For installation, features, and general use, see the [Zettlr repository](https://github.com/Zettlr/Zettlr) and [documentation](https://docs.zettlr.com/); to build, follow the upstream [development guide](https://github.com/Zettlr/Zettlr#building-from-source).

## What's different from Zettlr

- **MathJax instead of KaTeX.** Math is rendered with MathJax (CommonHTML), bundled locally with no CDN dependency, including [mhchem](https://mhchem.github.io/MathJax-mhchem/) for chemistry.

- **Configurable TeX macros.** Define your own macros in a config file; the same set is used both in the editor and in every export (see below).

- **Every export goes through Pandoc.** HTML, LaTeX, and PDF all run through Pandoc, so your configured filters and templates always apply and exported math matches what you see in the editor.
  (The upstream Chromium "Simple PDF" export, which bypassed Pandoc and silently ignored filters and templates, has been removed.)

## What it looks like

Everything below is captured from the real editor renderers; `just readme-demos <dir>` regenerates all of it.

### Math renders as you type

Math shows its LaTeX source while the cursor is inside it and renders with MathJax the moment the cursor leaves — including your own macros (here `\RR`):

![Typing inline and display math with live MathJax rendering](resources/screenshots/math-typing.gif)

### Theorem environments

Pandoc fenced divs (`::: theorem`, `::: proof`, …) render as styled environments while the document stays plain Pandoc markdown:

![Typing theorem and proof environments](resources/screenshots/amsthm-typing.gif)

![The theorem environment family: theorem, definition, remark, problem, warning, proof](resources/screenshots/env-gallery.png)

### Reviewing external edit propositions

An external tool (an agent, a script — see [External review propositions](#external-review-propositions)) can propose edits to the open document.
Each changed chunk is adjudicated in the editor: accept it, annotate it with a comment, or reject it to restore the original text:

![Accepting, commenting on, and rejecting review chunks](resources/screenshots/review-flow.gif)

## MathJax macros

This fork does **not** own an independent macro file. The canonical macro language lives in `~/.pandoc/styles/macros/`, alongside the TeX styles and templates that consume it. MathJax reads the generated projection at `~/.pandoc/templates/css/mathjax-macros.json`; TikZ compilation reads the same source macros through the central `dzg-tikz` template graph.

To add or change a macro, edit the canonical source under `~/.pandoc/styles/macros/` and run the central `generate-math-macros` recipe (or `~/.pandoc/bin/generate-mathjax-config.py`). The generated JSON/JS/HTML files are derivatives and must not be edited or overridden in the Zettlr profile. The desktop launcher regenerates those central projections before launching.

The generated JSON uses the standard MathJax [`tex.macros`](https://docs.mathjax.org/en/latest/input/tex/macros.html) shape: a JSON object mapping each macro name to its definition — a replacement string or `[replacement, argCount]`. Zettlr consumes that projection read-only; malformed or missing central configuration is reported rather than silently replaced by bundled defaults.

For example, the semantic fibre-product macro is centrally defined as `\fiberprod{X}{S}{Y}` and projects to a three-argument MathJax macro rendering the complete object `X \times_S Y`.

## Portable snippets

Snippets use the standard VS Code `.code-snippets` JSONC format and TextMate/VS
Code snippet-body syntax. There is no Zettlr-specific snippet file format.
The default source is `~/.pandoc/snippets/snippets.code-snippets`.
**Preferences → Snippets → Snippets file** can point at any `.code-snippets`
file, so the source can live in a dotfiles repository or be shared directly
with another editor. It can be edited in **Open snippets editor** or with any
external editor; external changes are watched and reloaded.

For example:

```jsonc
{
  "Theorem": {
    "scope": "markdown",
    "prefix": "thm",
    "body": [
      "::: {.theorem}",
      "${1:Statement}",
      ":::",
      "$0"
    ]
  },
  "Alpha": {
    "scope": "latex",
    "prefix": "ga",
    "body": "\\alpha"
  }
}
```

Snippets participate in the ordinary always-on completion menu alongside words
from the current buffer and Zettlr's context-specific completion sources.
CodeMirror owns fuzzy matching/ranking, active snippet fields, indentation, and
**Tab / Shift-Tab / Escape** navigation. In Markdown, a parsed math zone also
exposes the standard `latex`/`tex` language scopes, so a normal `scope: "latex"`
snippet is available in mathematical source without proprietary snippet fields.

## QuickTeX

QuickTeX is separate from snippets. **Preferences → Snippets → QuickTeX
configuration** points directly at a QuickTeX Vimscript configuration file, and
**QuickTeX plugin directory** points at the QuickTeX installation. Neovim sources
and evaluates the real Vimscript configuration whenever it is loaded or changed;
Zettlr does not parse QuickTeX Vimscript or translate it into `.code-snippets`.
The editor's synchronous Space command follows QuickTeX's `ExpandWord()` contract:
on a hit it inserts the evaluated dictionary value verbatim (including any
configured trailing space), while a miss immediately falls through to ordinary
Space insertion.

QuickTeX owns exact-prefix **Space** expansion. Every Space checks the preceding
QuickTeX keyword in the active prose/math namespace first. An exact match expands
immediately and consumes the Space; a miss falls through to ordinary Space
handling. QuickTeX definitions are not injected into the autocomplete menu.

## Building and running

The build is identical to upstream Zettlr.
A `justfile` wraps the common tasks:

- `just launch` — run in development mode

- `just package` — build a packaged Linux (x64) app

- `just run-packaged` — run the built binary

## External review propositions

Install the desktop launcher to expose the standalone review command:

```sh
just install-desktop-launcher
zettlr-pandoc-review-diff \
  --document /path/to/document.md \
  --patch /path/to/proposition.diff \
  --description "Review proposition" \
  --port 27412
```

The running editor validates and applies the unified patch.
The command exits nonzero when the editor refuses the proposition.

## License

This software is licensed via the [GNU GPL v3-License](https://www.gnu.org/licenses/gpl-3.0.en.html), as is upstream Zettlr.

The Zettlr brand (including name, icons, and everything Zettlr can be identified with) is excluded and all rights reserved.
[Read about the logo usage](https://www.zettlr.com/press#usage-rights).
