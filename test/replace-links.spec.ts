import { ChangeSet, Text } from '@codemirror/state'
import { retargetLinks } from '@common/util/replace-links'
import { WikilinkIndex, type WikilinkDocument } from '@common/util/wikilink-resolution'
import { strictEqual } from 'assert'

/** The text after the retargeting replacements, applied as a workspace edit applies them. */
function retargeted (markdown: string, ...args: [string, Parameters<typeof retargetLinks>[2], WikilinkIndex, WikilinkIndex]): string {
  const replacements = retargetLinks(markdown, ...args)
  const changes = ChangeSet.of(replacements.map(({ from, to, text }) => ({ from, to, insert: text })), markdown.length)
  return changes.apply(Text.of(markdown.split('\n'))).toString()
}

const root = '/ws'
const sourcePath = `${root}/programs/source.md`

function document (relativePath: string, extra: Partial<WikilinkDocument> = {}): WikilinkDocument {
  return { path: `${root}/${relativePath}`, root, id: '', title: undefined, aliases: [], ...extra }
}

describe('Link retargeting after a rename', function () {
  const others = [ document('programs/source.md'), document('elsewhere/zettelkasten-luhmann.md') ]
  const before = new WikilinkIndex([
    ...others,
    document('notes/zettelkasten.md', { id: '20240101120000', aliases: ['ZK'] })
  ])
  const after = new WikilinkIndex([
    ...others,
    document('notes/luhmann-zettelkasten.md', { id: '20240101120000', aliases: ['ZK'] })
  ])
  const move = { from: `${root}/notes/zettelkasten.md`, to: `${root}/notes/luhmann-zettelkasten.md` }

  it('gives every link that named the old path the new written form, keeping heading and label', function () {
    const markdown = [
      'See [[zettelkasten]], [[Zettelkasten.md|the method]] and [[notes/zettelkasten#Origins|origins]].',
      'A relative link: [[../notes/zettelkasten.md]].',
      ''
    ].join('\n')
    strictEqual(retargeted(markdown, sourcePath, move, before, after), [
      'See [[luhmann-zettelkasten]], [[luhmann-zettelkasten|the method]] and [[luhmann-zettelkasten#Origins|origins]].',
      'A relative link: [[luhmann-zettelkasten]].',
      ''
    ].join('\n'))
  })

  it('keeps links by ID or alias, and links to other documents', function () {
    const markdown = 'By ID [[20240101120000]], by alias [[ZK]], and another [[zettelkasten-luhmann]].\n'
    strictEqual(retargeted(markdown, sourcePath, move, before, after), markdown)
  })
})

describe('Link retargeting after a directory rename', function () {
  const unmoved = [ document('index.md'), document('deep/x/lemma.md'), document('notes/basis.md') ]
  const before = new WikilinkIndex([ ...unmoved, document('other/lemma.md'), document('other/chain.md') ])
  const after = new WikilinkIndex([ ...unmoved, document('x/lemma.md'), document('x/chain.md') ])
  const move = { from: `${root}/other`, to: `${root}/x` }

  it('retargets a name the rename gave to another document, and a relative link into the directory', function () {
    const markdown = 'Lemma [[x/lemma]], chain [[./other/chain.md#Step]], basis [[basis]].\n'
    strictEqual(
      retargeted(markdown, `${root}/index.md`, move, before, after),
      'Lemma [[deep/x/lemma]], chain [[chain#Step]], basis [[basis]].\n'
    )
  })

  it('retargets a relative link out of the renamed directory, read from its old location', function () {
    const markdown = 'Basis [[../notes/basis.md]], sibling [[./lemma.md]].\n'
    strictEqual(
      retargeted(markdown, `${root}/other/chain.md`, { from: `${root}/other`, to: `${root}/x/sub` }, before,
        new WikilinkIndex([ ...unmoved, document('x/sub/lemma.md'), document('x/sub/chain.md') ])),
      'Basis [[basis]], sibling [[./lemma.md]].\n'
    )
  })
})
