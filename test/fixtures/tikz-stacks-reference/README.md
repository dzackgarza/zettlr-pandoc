# TikZ / Stacks visual references

These fixtures are the durable visual oracle for editor TikZ sizing.

`just capture-tikz <output-dir>` loads the authoritative Stacks Project tag
pages at a 1536×1024 Chromium viewport, verifies that their recorded
`\xymatrix` sources still match `test/tikz-stacks-reference.ts`, renders the
equivalent TikZ diagrams through Zettlr's production Pandoc → pdflatex →
pdf2svg path, and emits page screenshots, per-diagram crops, side-by-side
comparisons, and `tikz-stacks-reference.json`.

The checked-in PNGs and `measurements.json` here are the 2026-09-14 reference
capture. The controlled A/B comparison uses the Stacks desktop equation
measure (633 px) and body size (14 px) on the Zettlr side as well, so the paired
images compare diagram scale rather than unrelated column geometry.

Reference tags:

- `01JO` — fibre-product square, universal cone, residue-field cone.
- `07JW` — snake-lemma ladder.
- `067L` — immersion triangle.

The current sizing contract is not a semantic size bucket. The TeX/pdf2svg
physical box is projected into editor ems and then given the same 1.1 display-
math scale already used by Zettlr's MathJax renderer; figures may shrink to fit
but are never enlarged according to path count, density, or diagram class.

