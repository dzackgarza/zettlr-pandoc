/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Ignore rule tests
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The ignore rules decide which files and folders of a
 *                  workspace the app lists. These tests state what a rule
 *                  hides, which rules judge a path, and how Hide, Unhide and
 *                  a rename change a rules file.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import {
  createIgnoreFilter,
  mapPathRules,
  pathRuleLine,
  ruleForName,
  ruleForPath,
  setPathIgnored,
  type IgnoreRuleSources
} from 'source/common/util/ignore-rules'

const ROOT = '/home/user/writing'

function sources (globalRules: string[], rulesFile = '', showIgnored = false): IgnoreRuleSources {
  return { globalRules, workspaceRules: new Map([[ ROOT, rulesFile ]]), showIgnored }
}

describe('Ignore rules', function () {
  describe('what a rule hides', function () {
    const filter = createIgnoreFilter(sources([ '*scripts*', '*_files/', 'references/', 'AGENTS.md' ]))
    const hidden = (relative: string, isDirectory: boolean): boolean => filter.hides(`${ROOT}/${relative}`, isDirectory)

    it('hides files and folders whose name holds "scripts", at any depth', function () {
      assert.equal(hidden('scripts', true), true)
      assert.equal(hidden('coble/scripts', true), true)
      assert.equal(hidden('coble/build-scripts.md', false), true)
    })

    it('hides the content of a hidden folder', function () {
      assert.equal(hidden('coble/scripts/plot.md', false), true)
      assert.equal(hidden('coble/scripts/lib', true), true)
    })

    it('applies a rule with a trailing slash to folders only', function () {
      assert.equal(hidden('category-theory/Roadmap_files', true), true)
      assert.equal(hidden('category-theory/Roadmap_files/figure.md', false), true)
      assert.equal(hidden('category-theory/Roadmap_files', false), false)
      assert.equal(hidden('references', true), true)
      assert.equal(hidden('coble/references', true), true)
      assert.equal(hidden('references.md', false), false)
    })

    it('hides a file by its exact name in every folder', function () {
      assert.equal(hidden('AGENTS.md', false), true)
      assert.equal(hidden('coble/AGENTS.md', false), true)
      assert.equal(hidden('coble/AGENTS.md.bak', false), false)
      assert.equal(hidden('agents.md', false), false)
    })

    it('leaves every other path listed', function () {
      assert.equal(hidden('coble', true), false)
      assert.equal(hidden('coble/notes.md', false), false)
    })
  })

  describe('which rules judge a path', function () {
    it('adds the rules file of the workspace to the global rules', function () {
      const filter = createIgnoreFilter(sources([ '*_files/' ], '/coble/papers/\n!Keep_files/\n'))
      assert.equal(filter.hides(`${ROOT}/coble/papers`, true), true)
      assert.equal(filter.hides(`${ROOT}/other/coble/papers`, true), false, 'a rule with a leading slash is anchored at the workspace root')
      assert.equal(filter.hides(`${ROOT}/Roadmap_files`, true), true)
      assert.equal(filter.hides(`${ROOT}/Keep_files`, true), false, 'a negation in the rules file overrides a global rule')
    })

    it('never hides a workspace root or a path outside every workspace', function () {
      const filter = createIgnoreFilter(sources([ '*' ]))
      assert.equal(filter.hides(ROOT, true), false)
      assert.equal(filter.hides('/home/user/elsewhere/notes.md', false), false)
      assert.equal(filter.hides(`${ROOT}/notes.md`, false), true)
    })

    it('judges a path by the innermost workspace that contains it', function () {
      const inner = `${ROOT}/coble`
      const filter = createIgnoreFilter({
        globalRules: [],
        workspaceRules: new Map([[ ROOT, 'drafts/\n/coble/\n' ], [ inner, '' ]]),
        showIgnored: false
      })
      assert.equal(filter.hides(inner, true), true, 'the outer workspace judges the folder of the inner one')
      assert.equal(filter.hides(`${inner}/drafts`, true), false, 'the inner workspace has its own rules')
      assert.equal(filter.hides(`${ROOT}/drafts`, true), true)
    })

    it('lists every path while the reveal toggle is on, and still reports the match', function () {
      const filter = createIgnoreFilter(sources([ 'references/' ], '', true))
      assert.equal(filter.hides(`${ROOT}/references`, true), false)
      assert.equal(filter.matches(`${ROOT}/references`, true), true)
      assert.equal(filter.matches(`${ROOT}/coble`, true), false)
    })
  })

  describe('a rule made from a name or a path', function () {
    it('names a folder with a trailing slash and a file without one', function () {
      assert.equal(ruleForName('references', true), 'references/')
      assert.equal(ruleForName('AGENTS.md', false), 'AGENTS.md')
    })

    it('anchors a path rule at the workspace root', function () {
      assert.equal(ruleForPath(ROOT, `${ROOT}/coble/scripts`, true), '/coble/scripts/')
      assert.equal(ruleForPath(ROOT, `${ROOT}/coble/notes.md`, false), '/coble/notes.md')
    })

    it('matches the literal name when the name holds pattern characters', function () {
      const name = '#[draft] what?*.md'
      const byName = createIgnoreFilter(sources([ruleForName(name, false)]))
      assert.equal(byName.hides(`${ROOT}/sub/${name}`, false), true)
      assert.equal(byName.hides(`${ROOT}/sub/#d whatever.md`, false), false)

      const byPath = createIgnoreFilter(sources([], ruleForPath(ROOT, `${ROOT}/sub/${name}`, false)))
      assert.equal(byPath.hides(`${ROOT}/sub/${name}`, false), true)
      assert.equal(byPath.hides(`${ROOT}/sub/#d whatever.md`, false), false)
    })
  })

  describe('Hide and Unhide of one path', function () {
    const scripts = `${ROOT}/coble/scripts`

    it('hides a listed path with one anchored rule and unhides it by removing that rule', function () {
      const original = '# local rules\n/data/\n'
      const hiddenText = setPathIgnored(original, [], ROOT, scripts, true, true)
      assert.equal(hiddenText, '# local rules\n/data/\n/coble/scripts/\n')
      assert.equal(setPathIgnored(hiddenText, [], ROOT, scripts, true, false), original)
    })

    it('starts a rules file when the workspace has none', function () {
      assert.equal(setPathIgnored('', [], ROOT, scripts, true, true), '/coble/scripts/\n')
    })

    it('unhides a path that a pattern hides with a negation, and hides it again by removing the negation', function () {
      const globalRules = ['*scripts*']
      const unhidden = setPathIgnored('', globalRules, ROOT, scripts, true, false)
      assert.equal(unhidden, '!/coble/scripts/\n')
      assert.equal(createIgnoreFilter(sources(globalRules, unhidden)).hides(scripts, true), false)
      assert.equal(createIgnoreFilter(sources(globalRules, unhidden)).hides(`${ROOT}/scripts`, true), true)
      assert.equal(setPathIgnored(unhidden, globalRules, ROOT, scripts, true, true), '')
    })
  })

  describe('rules that name a renamed, moved or deleted path', function () {
    const text = '# keep\n/coble/scripts/\n!/coble/scripts/keep.md\n/coble/scripts-old/\nscripts/\n'

    it('follows a rename of the path and of a folder above it', function () {
      const renamed = mapPathRules(text, ROOT, `${ROOT}/coble`, rule => pathRuleLine(ROOT, `${ROOT}/k3`, rule))
      assert.equal(renamed, '# keep\n/k3/scripts/\n!/k3/scripts/keep.md\n/k3/scripts-old/\nscripts/\n')
    })

    it('touches only the rules at or under the path', function () {
      const removed = mapPathRules(text, ROOT, `${ROOT}/coble/scripts`, () => undefined)
      assert.equal(removed, '# keep\n/coble/scripts-old/\nscripts/\n')
    })
  })
})
