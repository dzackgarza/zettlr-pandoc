import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { editQuartoBookSource } from 'source/app/util/quarto-book-editor'
import { parseQuartoProject } from 'source/app/util/quarto-project'

describe('Quarto book manifest editor', function () {
  let root: string
  let manifest: string
  let source: string

  beforeEach(async function () {
    root = await mkdtemp(path.join(tmpdir(), 'zettlr-quarto-book-editor-'))
    await mkdir(path.join(root, 'chapters'), { recursive: true })
    await Promise.all([
      writeFile(path.join(root, 'index.md'), '# Index\n'),
      writeFile(path.join(root, 'chapters', 'a.md'), '# A\n'),
      writeFile(path.join(root, 'chapters', 'b.md'), '# B\n'),
      writeFile(path.join(root, 'extra.md'), '# Extra\n')
    ])
    manifest = path.join(root, '_quarto.yml')
    source = [
      '# keep this project comment',
      'project:',
      '  type: book',
      'book:',
      '  title: Demo',
      '  chapters:',
      '    - index.md # keep this chapter comment',
      '    - part: First',
      '      chapters:',
      '        - chapters/a.md',
      'format:',
      '  html:',
      '    toc: true # unrelated setting survives',
      ''
    ].join('\n')
  })

  afterEach(async function () {
    await rm(root, { recursive: true, force: true })
  })

  it('adds an omitted chapter after the active chapter without rewriting unrelated YAML', function () {
    const edited = editQuartoBookSource(root, manifest, source, {
      kind: 'add-chapter',
      chapterPath: 'extra.md',
      placement: { kind: 'after-chapter', chapterPath: 'index.md' }
    })
    const project = parseQuartoProject(root, edited)

    assert.deepEqual(project.files.map(file => path.relative(root, file)), [
      'index.md', 'extra.md', path.join('chapters', 'a.md')
    ])
    assert.match(edited, /# keep this project comment/)
    assert.match(edited, /# unrelated setting survives/)
    assert.match(edited, /index\.md # keep this chapter comment/)
  })

  it('moves a chapter into a part and back out to top-level book order', function () {
    let edited = editQuartoBookSource(root, manifest, source, {
      kind: 'add-chapter', chapterPath: 'extra.md'
    })
    edited = editQuartoBookSource(root, manifest, edited, {
      kind: 'move-chapter',
      chapterPath: 'extra.md',
      placement: { kind: 'part-end', partIndex: 1 }
    })
    let project = parseQuartoProject(root, edited)
    assert.deepEqual(project.navigation[1], {
      kind: 'part',
      title: 'First',
      chapters: [ path.join(root, 'chapters', 'a.md'), path.join(root, 'extra.md') ]
    })

    edited = editQuartoBookSource(root, manifest, edited, {
      kind: 'move-chapter', chapterPath: 'extra.md', placement: { kind: 'book-end' }
    })
    project = parseQuartoProject(root, edited)
    assert.deepEqual(project.files.map(file => path.relative(root, file)), [
      'index.md', path.join('chapters', 'a.md'), 'extra.md'
    ])
  })

  it('creates a part around either an omitted or an already-included chapter', function () {
    let edited = editQuartoBookSource(root, manifest, source, {
      kind: 'add-part', title: 'Second', chapterPath: 'chapters/b.md'
    })
    let project = parseQuartoProject(root, edited)
    assert.deepEqual(project.navigation.at(-1), {
      kind: 'part', title: 'Second', chapters: [ path.join(root, 'chapters', 'b.md') ]
    })

    edited = editQuartoBookSource(root, manifest, edited, {
      kind: 'add-part', title: 'Landing', chapterPath: 'index.md'
    })
    project = parseQuartoProject(root, edited)
    assert.equal(project.files.filter(file => file === path.join(root, 'index.md')).length, 1)
    assert.deepEqual(project.navigation.at(-1), {
      kind: 'part', title: 'Landing', chapters: [ path.join(root, 'index.md') ]
    })
  })

  it('rejects a chapter outside the Project root', function () {
    assert.throws(() => editQuartoBookSource(root, manifest, source, {
      kind: 'add-chapter', chapterPath: '../elsewhere.md'
    }), Error)
  })

  it('uses an assembly symlink inside a bound manifest root instead of writing a ../ chapter path', async function () {
    const workspace = path.resolve('test', 'fixtures', 'quarto-bound-book')
    const boundManifest = path.join(workspace, '.book', '_quarto.yml')
    const boundSource = await readFile(boundManifest, 'utf8')

    const edited = editQuartoBookSource(workspace, boundManifest, boundSource, {
      kind: 'add-chapter',
      chapterPath: 'category-theory/index.md',
      placement: { kind: 'book-end' }
    })

    assert.match(edited, /- category-theory\/index\.md/)
    assert.doesNotMatch(edited, /\.\.\/category-theory\/index\.md/)
  })
})
