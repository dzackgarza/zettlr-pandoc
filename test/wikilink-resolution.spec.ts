import { deepStrictEqual, strictEqual } from 'assert'
import { WikilinkIndex, type WikilinkDocument } from '@common/util/wikilink-resolution'

const root = '/ws'

function document (relativePath: string, extra: Partial<WikilinkDocument> = {}): WikilinkDocument {
  return { path: `${root}/${relativePath}`, root, id: '', title: undefined, aliases: [], ...extra }
}

describe('Workspace wikilink resolution', function () {
  const index = new WikilinkIndex([
    document('programs/cusp-correspondence-morphism-chain.md'),
    document('adjacent-programs/halphen-index-2-moduli-program.md', { title: 'Halphen index 2', aliases: ['Halphen'] }),
    document('adjacent-programs/nodal-enriques-moduli-program.md', { id: '20240101120000' }),
    document('a/notes.md'),
    document('b/notes.md'),
    document('titled.md', { title: 'Notes' })
  ])
  const source = `${root}/programs/cusp-correspondence-morphism-chain.md`

  it('resolves a basename anywhere in the workspace, ignoring case and the extension', function () {
    for (const target of [ 'halphen-index-2-moduli-program', 'Halphen-Index-2-Moduli-Program.md' ]) {
      deepStrictEqual(index.resolve(target, source), {
        status: 'resolved',
        path: `${root}/adjacent-programs/halphen-index-2-moduli-program.md`,
        canonical: 'halphen-index-2-moduli-program',
        relative: false
      })
    }
  })

  it('resolves an ID, an alias and a title', function () {
    const resolvedPath = (target: string): string|undefined => {
      const resolution = index.resolve(target, source)
      return resolution.status === 'resolved' ? resolution.path : undefined
    }
    strictEqual(resolvedPath('20240101120000'), `${root}/adjacent-programs/nodal-enriques-moduli-program.md`)
    strictEqual(resolvedPath('halphen'), `${root}/adjacent-programs/halphen-index-2-moduli-program.md`)
    strictEqual(resolvedPath('Halphen index 2'), `${root}/adjacent-programs/halphen-index-2-moduli-program.md`)
  })

  it('reports a basename that two documents share as ambiguous, and a path suffix as unique', function () {
    deepStrictEqual(index.resolve('notes', source), {
      status: 'ambiguous',
      candidates: [ `${root}/a/notes.md`, `${root}/b/notes.md` ]
    })
    strictEqual(index.canonical(`${root}/a/notes.md`), 'a/notes')
    const resolution = index.resolve('b/notes', source)
    strictEqual(resolution.status === 'resolved' && resolution.path, `${root}/b/notes.md`)
  })

  it('lets a path suffix win over a title', function () {
    deepStrictEqual(index.resolve('titled', source).status, 'resolved')
    deepStrictEqual(index.resolve('notes', source).status, 'ambiguous')
  })

  it('resolves a document-relative path and names its written form', function () {
    deepStrictEqual(index.resolve('../adjacent-programs/nodal-enriques-moduli-program.md', source), {
      status: 'resolved',
      path: `${root}/adjacent-programs/nodal-enriques-moduli-program.md`,
      canonical: 'nodal-enriques-moduli-program',
      relative: true
    })
    deepStrictEqual(index.resolve('../missing.md', source), { status: 'missing' })
  })

  it('reports a target that names no document as missing', function () {
    deepStrictEqual(index.resolve('no-such-note', source), { status: 'missing' })
  })
})
