import { strict as assert } from 'node:assert'
import surfaceDocumentLoadError from 'source/win-main/util/surface-document-load-error'

describe('document-load error surface', function () {
  afterEach(function () {
    document.getElementById('zettlr-toast-container')?.remove()
  })

  it('logs the full diagnostic and shows a closable error toast', function () {
    const originalConsoleError = console.error
    const logged: string[] = []
    console.error = (...values: unknown[]) => {
      logged.push(values.map(String).join(' '))
    }

    try {
      surfaceDocumentLoadError(
        '/tmp/research/opened-document.md',
        new DOMException(
          'Reactive configuration could not be cloned',
          'DataCloneError'
        )
      )
    } finally {
      console.error = originalConsoleError
    }

    const toast = document.querySelector<HTMLElement>('.zettlr-toast.error')
    assert.ok(toast, 'A document-load failure must create an error toast')
    assert.match(toast.textContent ?? '', /opened-document\.md/)
    assert.match(
      toast.textContent ?? '',
      /Reactive configuration could not be cloned/
    )

    const diagnostic = logged.join('\n')
    assert.match(diagnostic, /MainEditor.*opened-document\.md/)
    assert.match(diagnostic, /DataCloneError/)
    assert.match(diagnostic, /Reactive configuration could not be cloned/)
    assert.doesNotMatch(diagnostic, /^\[object DOMException\]$/)

    toast.click()
    assert.equal(document.querySelector('.zettlr-toast.error'), null)
  })
})
