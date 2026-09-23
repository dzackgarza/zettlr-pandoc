import { strict as assert } from 'node:assert'
import {
  completionIconText,
  completionPresentationOptions,
  completionSource,
  withCompletionSource
} from 'source/common/modules/markdown-editor/autocomplete/completion-presentation'

describe('completion presentation', function () {
  it('adds source provenance without changing completion semantics', function () {
    const apply = (): void => {}
    const completion = withCompletionSource({
      label: '\\operatorname',
      detail: '[amsmath]',
      info: 'package documentation',
      type: 'function',
      boost: 12,
      apply
    }, 'LaTeX')

    assert.equal(completionSource(completion), 'LaTeX')
    assert.equal(completionIconText(completion), 'T')
    assert.equal(completion.label, '\\operatorname')
    assert.equal(completion.detail, '[amsmath]')
    assert.equal(completion.info, 'package documentation')
    assert.equal(completion.boost, 12)
    assert.strictEqual(completion.apply, apply)
  })

  it('renders a fixed source column and source icon through CodeMirror addToOptions', function () {
    const completion = withCompletionSource({ label: 'minimal model program', type: 'text' }, 'Dictionary')
    const icon = completionPresentationOptions[0].render(completion) as HTMLElement
    const source = completionPresentationOptions[1].render(completion) as HTMLElement

    assert.equal(icon.className, 'cm-completionIcon cm-completionSourceIcon')
    assert.equal(icon.textContent, 'D')
    assert.equal(source.className, 'cm-completionSource')
    assert.equal(source.textContent, '[Dictionary]')
  })

  it('keeps a semantic icon and an empty source column for legacy providers', function () {
    const completion = { label: 'function', type: 'function' }
    const icon = completionPresentationOptions[0].render(completion) as HTMLElement
    const source = completionPresentationOptions[1].render(completion) as HTMLElement

    assert.equal(completionIconText(completion), 'ƒ')
    assert.equal(icon.textContent, 'ƒ')
    assert.equal(source.textContent, '')
    assert.equal(source.getAttribute('aria-hidden'), 'true')
  })
})
