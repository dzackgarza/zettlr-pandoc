/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Toast action-affordance specs (issue #1, review A5 red)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks the action affordance onto the closable toast
 *                  utility: a toast may carry one labeled action button
 *                  (the surface that makes the committed workspace rename's
 *                  undo user-reachable, US-17). The action runs exactly
 *                  once, dismisses the toast, and never leaks onto
 *                  action-free toasts; dismissing the toast without the
 *                  button never runs the action.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import showToast from 'source/common/util/show-toast'

const CONTAINER_ID = 'zettlr-toast-container'

describe('Toast action affordance (review A5)', function () {
  afterEach(function () {
    document.getElementById(CONTAINER_ID)?.remove()
  })

  function toasts (): HTMLElement[] {
    return Array.from(document.querySelectorAll(`#${CONTAINER_ID} .zettlr-toast`))
  }

  it('renders one labeled action button and runs the action exactly once on click', function () {
    let actionRuns = 0
    showToast('Renamed thm:torelli to thm:headline across 4 documents.', 'info', 6000, {
      label: 'Undo',
      onAction: () => { actionRuns++ }
    })

    const toast = toasts()[0]
    assert.notStrictEqual(toast, undefined, 'the toast must render')

    const button = toast.querySelector<HTMLButtonElement>('button[data-toast-action]')
    assert.ok(button !== null, 'the action toast must render its action as a real button')
    assert.strictEqual(button.textContent, 'Undo', 'the button must carry the supplied label')

    assert.strictEqual(actionRuns, 0, 'rendering must not run the action')
    button.click()
    assert.strictEqual(actionRuns, 1, 'clicking the button must run the action exactly once')
    assert.strictEqual(toasts().length, 0, 'the acted-on toast must dismiss itself')
  })

  it('dismissing the toast body never runs the action', function () {
    let actionRuns = 0
    showToast('Renamed with pending undo.', 'info', 6000, {
      label: 'Undo',
      onAction: () => { actionRuns++ }
    })

    const toast = toasts()[0]
    assert.notStrictEqual(toast, undefined, 'the toast must render')
    toast.click()
    assert.strictEqual(toasts().length, 0, 'clicking the body must dismiss the toast')
    assert.strictEqual(actionRuns, 0, 'dismissal is not the action')
  })

  it('action-free toasts render no action button', function () {
    showToast('Loading workspace references failed.', 'error')
    const toast = toasts()[0]
    assert.notStrictEqual(toast, undefined, 'the toast must render')
    assert.strictEqual(
      toast.querySelector('button[data-toast-action]'),
      null,
      'a toast without an action must not grow a button'
    )
  })
})
