/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikZ editor display-size projection
 * CVM-Role:        Utility
 * License:         GNU GPL v3
 *
 * Description:     Projects the physical SVG box emitted by TeX/pdf2svg into
 *                  editor display-math ems. This is typography normalization
 *                  only: it does not classify diagram content or enlarge dense
 *                  diagrams independently of their TeX box.
 *
 * END HEADER
 */

/**
 * Zettlr's MathJax renderer displays mathematics at 1.1em (render-math.ts).
 * TikZ is display mathematics too, so use the same typographic scale rather
 * than making its 10pt standalone document map to prose-sized 1em. Exact
 * Stacks Project comparisons (01JO, 07JW, 067L) keep this factor within ~8%
 * of the corresponding XY-pic diagram widths measured in body-font ems.
 */
export const TIKZ_DISPLAY_MATH_SCALE = 1.1

/** Returns the SVG width in editor display-math ems. */
export function tikzWidthEm (svgMarkup: string, texFontSizePt: number): number|null {
  if (!(texFontSizePt > 0)) {
    return null
  }
  const svgOpen = /<svg\b[^>]*>/i.exec(svgMarkup)?.[0]
  if (svgOpen === undefined) {
    return null
  }
  const width = /\bwidth\s*=\s*["']\s*([0-9]+(?:\.[0-9]+)?)pt\s*["']/i.exec(svgOpen)
  if (width === null) {
    return null
  }
  const widthPt = Number(width[1])
  if (!Number.isFinite(widthPt) || widthPt <= 0) {
    return null
  }
  return widthPt / texFontSizePt * TIKZ_DISPLAY_MATH_SCALE
}
