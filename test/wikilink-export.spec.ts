import { deepStrictEqual, throws } from 'assert'
import { wikilinkExportMap } from '@common/util/wikilink-export'
import { WikilinkIndex, type WikilinkDocument } from '@common/util/wikilink-resolution'

const root = '/ws'

function document (relativePath: string): WikilinkDocument {
  return { path: `${root}/${relativePath}`, root, id: '', title: undefined, aliases: [] }
}

const index = new WikilinkIndex([ document('index.md'), document('programs/chain.md'), document('notes/basis.md') ])

const CHAIN = '# First step\n\nText.\n\n# Second step\n\nBack to [[#First step]].\n'

describe('Wikilink resolutions for an export', function () {
  it('maps each link that names a document of the export to its heading', function () {
    const inputs = [
      { path: `${root}/index.md`, markdown: '# Index\n\n[[chain#second step|the step]], [[./programs/chain.md]], [[basis]], [[nowhere]], [[chain#No such heading]].\n' },
      { path: `${root}/programs/chain.md`, markdown: CHAIN }
    ]
    deepStrictEqual(wikilinkExportMap(inputs, index), {
      inputs: [ { headings: 1 }, { headings: 2 } ],
      links: {
        'chain#second step': { input: 1, heading: 1 },
        './programs/chain.md': { input: 1, heading: 0 },
        '#First step': { input: 1, heading: 0 }
      }
    })
  })

  it('fails when one written target leads to two places', function () {
    const inputs = [
      { path: `${root}/index.md`, markdown: '# Index\n\n[[#Second step]]\n\n# Second step\n' },
      { path: `${root}/programs/chain.md`, markdown: CHAIN.replace('[[#First step]]', '[[#Second step]]') }
    ]
    throws(() => wikilinkExportMap(inputs, index), /leads to different places/)
  })

  it('fails when a link leads to a document without a heading', function () {
    const inputs = [
      { path: `${root}/index.md`, markdown: '# Index\n\n[[basis]]\n' },
      { path: `${root}/notes/basis.md`, markdown: 'No heading.\n' }
    ]
    throws(() => wikilinkExportMap(inputs, index), /no heading to link to/)
  })
})
