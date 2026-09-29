import { retargetLinks } from '@common/util/replace-links'
import { WikilinkIndex, type WikilinkDocument } from '@common/util/wikilink-resolution'
import { strictEqual } from 'assert'

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
    strictEqual(retargetLinks(markdown, sourcePath, move, before, after), [
      'See [[luhmann-zettelkasten]], [[luhmann-zettelkasten|the method]] and [[luhmann-zettelkasten#Origins|origins]].',
      'A relative link: [[luhmann-zettelkasten]].',
      ''
    ].join('\n'))
  })

  it('keeps links by ID or alias, and links to other documents', function () {
    const markdown = 'By ID [[20240101120000]], by alias [[ZK]], and another [[zettelkasten-luhmann]].\n'
    strictEqual(retargetLinks(markdown, sourcePath, move, before, after), markdown)
  })
})
