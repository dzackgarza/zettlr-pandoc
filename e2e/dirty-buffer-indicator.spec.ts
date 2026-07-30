// Renders the real tab bar so the unsaved-changes indicator can be looked at
// rather than reasoned about. A dirty-state affordance is only correct if it
// reads as dirty on screen, and the claim being made for it — that an unsaved
// tab is findable while scanning — is only testable against a row of tabs, in
// both themes. Screenshots land in the artifact directory for inspection.
import { strict as assert } from 'node:assert'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { Browser, Page } from 'playwright'
import { stringify } from 'yaml'
import {
  attach,
  createFixture,
  findEditorPage,
  preserveArtifacts,
  requireInitialized,
  shutdown
} from './support/electron-app'

// One directory per theme: preserveArtifacts clears its target, so a shared
// directory would leave only whichever theme tore down last.
const ARTIFACTS_ROOT = '/tmp/zettlr-dirty-buffer-indicator-e2e-latest'
const SIBLINGS = ['second-note.md', 'third-note.md', 'fourth-note.md']

interface RunningFixture {
  fixtureRoot: string | undefined
  appProcess: ChildProcess | undefined
  browser: Browser | undefined
  getOutput: () => string
  rendererEvents: string[]
  screenshots: Map<string, Buffer>
}

/**
 * Boots the app with four documents open in one leaf. createFixture opens a
 * single file, which cannot show whether one dirty tab stands out among clean
 * ones — so the extra files and the leaf state are written over its output
 * before the app starts, rather than by widening the shared harness for one
 * spec's needs.
 */
async function bootWithTabRow (
  fixture: RunningFixture,
  darkMode: boolean
): Promise<Page> {
  const created = await createFixture('zettlr-dirty-buffer-indicator-e2e-', {
    documentName: 'first-note.md',
    documentContents: '# First note\n\nSome prose to type into.\n',
    // autoDarkMode defaults to following the OS, which would render both runs
    // in whatever theme this machine happens to be set to and quietly turn a
    // two-theme check into the same theme twice.
    config: { darkMode, autoDarkMode: 'off', editor: { inputMode: 'default' } }
  })
  fixture.fixtureRoot = created.root

  const workspace = path.dirname(created.documentPath)
  const openFiles = [{ path: created.documentPath, pinned: false }]
  for (const sibling of SIBLINGS) {
    const siblingPath = path.join(workspace, sibling)
    await writeFile(siblingPath, `# ${sibling}\n\nUntouched.\n`, 'utf8')
    openFiles.push({ path: siblingPath, pinned: false })
  }
  await writeFile(
    path.join(created.configDirectory, 'documents.yaml'),
    stringify({
      '56b44854-b144-4a6f-8061-dcfeb6e512e8': {
        type: 'leaf',
        id: '7b4dd4f2-48a2-4279-b6c9-577132e64480',
        openFiles,
        activeFile: openFiles[0]
      }
    }),
    'utf8'
  )

  const app = await attach(created.configDirectory, fixture.rendererEvents, 120_000)
  fixture.appProcess = app.appProcess
  fixture.browser = app.browser
  fixture.getOutput = app.getOutput
  return await findEditorPage(requireInitialized(fixture.browser, 'browser'), 60_000)
}

for (const theme of ['light', 'dark'] as const) {
  describe(`unsaved-changes indicator (${theme})`, function () {
    this.timeout(180_000)

    const fixture: RunningFixture = {
      fixtureRoot: undefined,
      appProcess: undefined,
      browser: undefined,
      getOutput: () => '',
      rendererEvents: [],
      screenshots: new Map<string, Buffer>()
    }
    let page: Page

    async function shoot (name: string): Promise<void> {
      fixture.screenshots.set(
        `${theme}-${name}.png`,
        await page.locator('div.tab-container').screenshot()
      )
    }

    /** The row is too small to judge a 2px edge; this crops one tab. */
    async function shootTab (name: string): Promise<void> {
      fixture.screenshots.set(
        `${theme}-${name}-tab.png`,
        await page.locator('div[role="tab"]').first().screenshot({ scale: 'device' })
      )
    }

    before(async function () {
      page = await bootWithTabRow(fixture, theme === 'dark')
    })

    after(async function () {
      await preserveArtifacts(
        path.join(ARTIFACTS_ROOT, theme),
        fixture.fixtureRoot,
        fixture.getOutput(),
        fixture.rendererEvents,
        fixture.screenshots
      )
      await shutdown(fixture.browser, fixture.appProcess)
    })

    it('marks only the dirty tab, and yields the slot back on hover', async function () {
      const tabs = page.locator('div[role="tab"]')
      await tabs.first().waitFor({ state: 'visible', timeout: 60_000 })
      assert.equal(await tabs.count(), 1 + SIBLINGS.length)

      const indicators = page.locator('span.modification-indicator')
      assert.equal(await indicators.count(), 0, 'no clean tab may carry an indicator')
      await shoot('row-clean')

      await page.locator('.cm-content').first().click()
      await page.keyboard.type('dirty')
      await indicators.first().waitFor({ state: 'visible', timeout: 30_000 })
      assert.equal(
        await indicators.count(),
        1,
        'exactly the edited tab is marked, not the whole row'
      )
      await shoot('row-one-dirty')
      await shootTab('one-dirty')

      // The dot sits in the close control's slot, so the cross must be out of
      // the way while the pointer is elsewhere — otherwise the tab shows two
      // glyphs competing for the same meaning.
      const dirtyTab = tabs.first()
      const close = dirtyTab.locator('span.close')
      assert.equal(await close.isVisible(), false, 'the close cross must yield to the dot')

      // ...and so must every other tab's, or the dot is just one more small
      // glyph in a row of small glyphs and stands out from none of them.
      const visibleCrosses = await page.locator('span.close:visible').count()
      assert.equal(visibleCrosses, 0, 'an unhovered row shows no close crosses')

      // ...and take the slot back on hover, so closing a dirty tab stays a
      // single click rather than a hunt for a target that moved.
      await dirtyTab.hover()
      await close.waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(
        await indicators.first().isVisible(),
        false,
        'the dot must yield to the close cross under the pointer'
      )
      await shoot('row-dirty-hover')
      await shootTab('dirty-hover')

      // The old '* ' prefix shifted the filename sideways; the dot must not.
      const filename = await dirtyTab.locator('span.filename').innerText()
      assert.equal(filename.includes('*'), false, 'the filename must carry no asterisk')

      // The case that matters most: the author edits a note, moves to another
      // tab, and the unsaved one is now neither active nor under the pointer.
      // That is the tab whose state has to survive on its own.
      await tabs.nth(2).click()
      await page.locator('div[role="tab"].active').first().waitFor({ timeout: 10_000 })
      assert.equal(
        await dirtyTab.evaluate((el) => el.classList.contains('active')),
        false,
        'the edited tab must have handed off active state'
      )
      assert.equal(
        await indicators.count(),
        1,
        'the unsaved mark survives losing focus'
      )
      await shoot('row-dirty-inactive')
      await shootTab('dirty-inactive')

    })
  })
}
