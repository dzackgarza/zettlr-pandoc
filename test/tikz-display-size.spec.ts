import { strict as assert } from 'assert'
import {
  TIKZ_DISPLAY_MATH_SCALE,
  tikzWidthEm
} from 'source/common/modules/markdown-editor/tikz-display-size'

describe('TikZ editor display-size projection', function () {
  it('projects the physical TeX width into the same 1.1em display-math scale as MathJax', function () {
    assert.strictEqual(TIKZ_DISPLAY_MATH_SCALE, 1.1)
    assert.ok(Math.abs((tikzWidthEm('<svg width="72.842pt" height="59pt"></svg>', 10) ?? 0) - 8.01262) < 1e-10)
    assert.strictEqual(tikzWidthEm('<svg width="120pt"></svg>', 12), 11)
  })

  it('does not guess when the SVG lacks a TeX point width', function () {
    assert.strictEqual(tikzWidthEm('<svg viewBox="0 0 100 50"></svg>', 10), null)
    assert.strictEqual(tikzWidthEm('<svg width="100px"></svg>', 10), null)
  })
})
