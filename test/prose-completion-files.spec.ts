import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  appendPortableProseCompletion,
  parsePortableProseCompletions,
  proseWordsFromHunspellDic,
} from 'source/app/util/prose-completion-files'

describe('portable prose completion files', function () {
  it('reads words and phrases while preserving comments as metadata only', function () {
    assert.deepStrictEqual(
      parsePortableProseCompletions('# shared terms\ntherefore\non the other hand\n\n'),
      [ 'therefore', 'on the other hand' ]
    )
  })

  it('projects the explicit word column from a Hunspell dictionary', function () {
    assert.deepStrictEqual(
      proseWordsFromHunspellDic('3\nrun/AB po:verb\ncategory/S\nfoo\\/bar\n'),
      [ 'run', 'category', 'foo/bar' ]
    )
  })

  it('appends a phrase to the portable file without rewriting its existing bytes', async function () {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zettlr-prose-completions-'))
    const file = path.join(root, 'prose.txt')
    try {
      const original = '# portable catalogue\ntherefore\n'
      await writeFile(file, original, 'utf8')
      assert.strictEqual(await appendPortableProseCompletion(file, '  on   the other hand  '), true)
      assert.strictEqual(await appendPortableProseCompletion(file, 'on the other hand'), false)
      const after = await readFile(file, 'utf8')
      assert.ok(after.startsWith(original), 'adding an entry must append rather than normalize/rewrite the file')
      assert.deepStrictEqual(parsePortableProseCompletions(after), [ 'therefore', 'on the other hand' ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
