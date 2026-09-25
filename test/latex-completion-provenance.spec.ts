import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { TIKZ_CONTROL_WORDS } from 'source/common/modules/markdown-editor/autocomplete/generated-tikz-commands'

describe('external completion catalogue provenance', function () {
  it('ships the LaTeX Workshop command snapshot with explicit MIT provenance', async function () {
    const root = path.join(process.cwd(), 'static', 'autocomplete')
    const commands = JSON.parse(await readFile(path.join(root, 'latex-workshop-commands.json'), 'utf8')) as Record<string, unknown>
    const environments = JSON.parse(await readFile(path.join(root, 'latex-workshop-environments.json'), 'utf8')) as unknown[]
    const provenance = await readFile(path.join(root, 'PROVENANCE.toml'), 'utf8')
    const license = await readFile(path.join(root, 'LATEX-WORKSHOP-LICENSE.txt'), 'utf8')
    assert.ok(Object.keys(commands).length >= 250, 'the source must remain a substantive maintained command catalogue')
    assert.ok(environments.length >= 50, 'the source must retain the maintained environment catalogue')
    assert.match(provenance, /source_repository = "https:\/\/github\.com\/James-Yu\/LaTeX-Workshop"/)
    assert.match(provenance, /data\/environments\.json/)
    assert.match(provenance, /source_commit = "[0-9a-f]{40}"/)
    assert.match(license, /MIT License/)
  })

  it('keeps the generated TikZ control-word catalogue synchronized with the installed grammar', async function () {
    const grammar = await readFile(
      path.join(process.cwd(), 'node_modules', '@tikz-editor', 'lezer-tikz', 'src', 'grammar', 'tikz.grammar'),
      'utf8'
    )
    const expected = [...new Set(
      [...grammar.matchAll(/"\\\\([A-Za-z@]+)/g)].map(match => `\\${match[1]}`)
    )].sort((a, b) => a.localeCompare(b))
    assert.deepStrictEqual([...TIKZ_CONTROL_WORDS], expected)
  })
})
