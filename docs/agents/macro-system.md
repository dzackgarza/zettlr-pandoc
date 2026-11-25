# 1. Central mathematical macro system

- **Only semantic source of truth:** `~/.pandoc/styles/macros/` (the user's ~1600-macro
  authoring language). Zettlr is a consumer. It must never seed, edit, bundle, prefer,
  or fall back to an app-local macro definition file.
- **Generated MathJax projection:** `~/.pandoc/templates/css/mathjax-macros.json`
  and `~/.pandoc/templates/css/mathjax-paired-delimiters.json`, both
  written by `~/.pandoc/bin/generate-mathjax-config.py`. The generator runs in
  the project environment of `pandoc-config` (it imports pylatexenc), so a
  caller runs the recipe: `just --justfile ~/.pandoc/justfile generate-math-macros`.
  `zettlr-pandoc-boot` runs it before a start
  ([desktop-launcher.md](desktop-launcher.md)).
- **App load:** `source/app/util/load-mathjax-macros.ts` resolves the central generated
  files and fails loudly when one is absent. The `mathjax-macros` and
  `mathjax-paired-delimiters` IPC channels in `source/app/lifecycle.ts`
  serve the same read-only projections to renderer consumers.
  - **A paired delimiter of the macro tree is no macro.** A
    `\DeclarePairedDelimiter` of `~/.pandoc` (`\qty`, `\ceil`) is an entry
    `name: [left, right]` of `mathjax-paired-delimiters.json`, which the
    renderer gives to the `mathtools` package of MathJax
    (`mathtools.pairedDelimiters` of the TeX input). The package gives each
    form of the PDF: `\qty{x}` without scaling, `\qty*{x}` with
    `\left \right`, `\qty[\big]{x}` with `\bigl \bigr`. A macro of the
    macro map cannot have the star or the size. Proof:
    `test/mathtex-to-html.spec.ts` ("renders each form of a paired
    delimiter"): each call and its LaTeX meaning give the same CommonHTML
    in a process that loads the real `~/.pandoc`.
  - `loadCanonicalMathJaxMacros` and `loadCanonicalMathJaxPairedDelimiters`
    throw `MacroSourcesUnavailableError` for a projection that cannot be read
    or has another form; the message names the recipe.
  - `loadCanonicalTexMacroCommands` lists each control word that the TeX
    sources of the macro tree declare, also the macros of the compiler only,
    which the projection does not hold. `loadCanonicalMacroInventory` merges
    those declarations with the projection by control word and keeps each
    repeated declaration. A folder or a source file that the filesystem refuses is
    in `notRead`; a root that refuses its content throws
    `MacroSourcesUnavailableError`.
  - `loadMathJaxMacros` reads one projection that a spec names. An
    absent file gives an empty map; a malformed one throws. Production code
    does not call it.
- **Format/validation:** `packages/tikz-render/src/mathjax-config.ts`
  (`parseMathJaxMacros`, `parseMathJaxPairedDelimiters`; malformed central
  projections fail rather than being replaced with bundled defaults). Its
  `mathJaxPackages` are the TeX packages of each renderer.
- **Render:** `source/common/util/mathtex-to-html.ts` (`initializeMathJax`, local
  CommonHTML), wired in `source/common/modules/window-register/index.ts` (each
  window) and in the update provider (the changelog of the main process).
  - The first call of `initializeMathJax` builds the renderer; a later call
    gets the same promise and its arguments do nothing. A change of the
    projection needs a restart.
  - The output has the complete stylesheet (`adaptiveCSS: false`): widgets
    render one at a time, and an adaptive stylesheet has no rules for a
    construct that is first used after the start. The mhchem glyphs are
    registered on the font class before an output jax is made, because with
    the complete stylesheet only that registration gives the `@font-face`
    rules of the extension.
  - A display equation that is wider than its pane scrolls in its own box
    (`displayOverflow: "scroll"`).
  - The window keeps 2048 rendered equations (`BROWSER_RENDER_CACHE_LIMIT`).
    With fewer entries than a document has equations, a scroll evicts each
    equation before it comes back (#136: 444 equations, 610 to 730 ms for
    each pass at 256).
  - The completion catalogue (`mathJaxCompletionCatalogue`) is read from the
    parse maps of the TeX input that renders. MathJax has no public
    enumeration of a parse map; the catalogue reads the private `map` of
    `AbstractParseMap` (MathJax-src `ts/input/tex/TokenMap.ts`) and only
    control words, not control symbols such as `\%`.
- **TikZ:** TeX compilation follows the real central `dzg-tikz` template/include
  graph.
- **`~/.pandoc` owns the math of an export.** The application assembles no
  MathJax configuration and no TeX preamble for an export
  (`exporter/export-math.ts`); there is no setting that turns such a path on.
  An export without a template of its own uses the template of
  `~/.pandoc/templates` for its writer (`PANDOC_DIRECTORY_TEMPLATES` in
  `exporter/resolve-export.ts`):

  | Writer | Template of `~/.pandoc/templates` |
  | --- | --- |
  | `html`, `html5`, `html4` | `pandoc_preview_template.html` |
  | `s5`, `slidy`, `slideous`, `dzslides`, `chunkedhtml` | `pandoc_<writer>_template.html` |
  | `revealjs` | `pandoc_revealjs_template.html` |
  | `latex`, `pdf` | `research_draft.tex` |
  | `beamer` | `research_beamer.tex` |
  | `context` | `pandoc_context_template.tex` |

  The template of an HTML writer or a TeX writer (`HTML_WRITERS`,
  `TEX_WRITERS` of `pandoc-maps.ts`) owns the macros. A template of a
  Project, of the defaults file or of the settings goes before it and then
  owns the math. A listed template that is no file stops the export with
  its path.
- **Each other writer gets the macros from the reader** (`macroInputOf`,
  the stage `math.owner: "macro-input"` of `ResolvedExport`). The first
  input of the export is `~/.pandoc/templates/css/math-macros.md`: the
  `\newcommand` line of each macro, which
  `~/.pandoc/bin/generate-mathjax-config.py` writes. The extension
  `latex_macros` of the reader applies each definition to the math of the
  inputs after it, so Word gets OMML, ODT, EPUB and JATS get MathML, and a
  writer that keeps TeX (Markdown, plain text) gets the TeX of the
  expansion. The filter `~/.pandoc/filters/math-macros.lua` runs after the
  leading filters and removes the definitions from the document.
  - Only the reader `markdown` has `latex_macros`. An export of such a
    writer with another reader (`commonmark_x`, `gfm`) stops with that
    cause, and so does a Pandoc directory without one of the files.
  - A `% title` block holds only in the first input of Pandoc, so such an
    export loses it. A title in the YAML front matter holds.
  - ConTeXt is no LaTeX (it has no `\operatorname`): its last filter,
    `~/.pandoc/filters/context-mathml.lua`, gives each formula as the
    MathML of texmath, and the template loads the MathML module of
    ConTeXt.
  - texmath converts the expansion of 1503 of the 1580 macros of
    `~/.pandoc`; for the others Pandoc warns "Could not convert TeX math"
    and keeps the TeX. texmath gives a letter of `\mathbf` the variant
    bold-italic.
  - The math method of EPUB is MathML in Pandoc 3.11 and HTML text in
    Pandoc 3.9.0.2, the release of the hosted run. A profile that needs
    MathML in an EPUB names `html-math-method: mathml`.
  - Proof: `test/export-math.spec.ts` (real Pandoc and the real
    `~/.pandoc`: docx, odt, epub3, jats, gfm, plain, and a ConTeXt PDF),
    `test/export-document.spec.ts` (a Word export through the command),
    `test/export-resolved.spec.ts` (the stage and its filters). A spec
    starts ConTeXt from the folder of `kpsewhich -var-value=SELFAUTOLOC`:
    ConTeXt finds its tree from the path by which it runs, and through a
    link in `/usr/bin` it finds no `texmfcnf.lua` ("unknown script
    mtx-context.lua").
- **HTML export:** the HTML templates include one MathJax configuration
  (`mathjax-config.html` of `~/.pandoc/templates`; reveal.js has one of
  its own) whose macro line `~/.pandoc/bin/generate-mathjax-config.py`
  writes. The
  application gives them places and nothing else: the math method `mathjax`
  with its own MathJax component, and the Pandoc variables `mathjax-root`
  (the folder of the component) and `mathjax-fonts` (the folder of the font
  packages). The HTML profile makes a self-contained page, so Pandoc puts
  the component into the page, and the page cannot tell the folder from the
  address of the component: that is why the folder has a variable. Pandoc
  and the browser of the exported file are no Electron processes and read no
  file inside `app.asar`: `scripts/export-mathjax.js` names the MathJax
  files in the layout that MathJax expects around a component, webpack
  copies them to `.webpack/main/assets/mathjax`, and the package keeps that
  folder in `app.asar.unpacked` (`BUNDLED_EXPORT_MATHJAX`,
  `AssetsProvider.exportMathJaxDirectory`). The exported file loads the
  extensions and fonts from that folder at run time and asks no other
  machine for anything. Proof: `e2e/html-export-packaged.spec.ts` (the
  packaged app, with a macro of `~/.pandoc`), `test/export-math.spec.ts`
  (real Pandoc, the real templates, Chromium; the macro map and the places
  of each HTML writer of the list; pdflatex on a Beamer and a PDF export).
- **TeX export:** `research_draft.tex` loads the style of the macro tree, as
  it does for the PDF recipe. The exported `.tex` file needs the styles of
  `~/.pandoc` on the path of TeX. The MathJax projection is for MathJax
  only: a projection of a macro that LaTeX already defines (`\AA`) is no TeX
  definition. Proof: `test/export-document.spec.ts` (a LaTeX export,
  pdflatex).
- **A change of a template of `~/.pandoc` is a change of `pandoc-config`.**
  The hosted runner clones its `main`, so a change there lands before the
  change of this repository that needs it.
- **Semantic invariant:** macro meanings and arities are owned by `~/.pandoc`; Zettlr
  may project or adapt them to a renderer but must not redefine their mathematics. See
  `~/.pandoc/AGENTS.md` for the object-valued/atomic macro rule.
