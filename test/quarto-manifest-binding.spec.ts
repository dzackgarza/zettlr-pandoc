/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Quarto manifest binding
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A workspace may name a manifest that lives somewhere else
 *                  in it. The binding is the input and the project is derived
 *                  from it on every load: .ztr-directory carries the pointer
 *                  and never a copy of what the manifest says, and a chapter
 *                  reached through the assembly's symlinks is the real file.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { realpathSync } from 'fs'
import { cp, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import {
  bindQuartoManifest,
  parse as parseDirectory,
  unbindQuartoManifest
} from 'source/app/service-providers/fsal/fsal-directory'
import type { DirectorySettings, ProjectSettings } from 'source/types/common/fsal'

const FIXTURE = path.resolve('test', 'fixtures', 'quarto-bound-book')
const BINDING = path.join('.book', '_quarto.yml')

/** The settings a directory's dotfile holds, as they were written to disk. */
async function readDirectorySettings (directory: string): Promise<Partial<DirectorySettings>> {
  const text = await readFile(path.join(directory, '.ztr-directory'), 'utf8')
  return JSON.parse(text) as Partial<DirectorySettings>
}

function quartoManifest (project: ProjectSettings | null): Extract<ProjectSettings['manifest'], { kind: 'quarto' }> {
  assert.notEqual(project, null, 'the directory carries no project')
  const manifest = (project as ProjectSettings).manifest
  assert.equal(manifest.kind, 'quarto', `the project was derived from a ${manifest.kind} manifest`)
  return manifest as Extract<ProjectSettings['manifest'], { kind: 'quarto' }>
}

describe('a workspace bound to a manifest that lives elsewhere in it', function () {
  let workspace: string

  beforeEach(async function () {
    const root = await mkdtemp(path.join(tmpdir(), 'zettlr-quarto-binding-'))
    workspace = path.join(root, 'writing')
    await cp(FIXTURE, workspace, { recursive: true, verbatimSymlinks: true })
  })

  afterEach(async function () {
    await rm(path.dirname(workspace), { recursive: true, force: true })
  })

  it('persists the binding alone, and derives the project from the manifest it names', async function () {
    const unbound = await parseDirectory(workspace)
    assert.equal(unbound.settings.project, null, 'an unbound workspace holds no project: its root carries no manifest')

    const outcome = await bindQuartoManifest(unbound, path.join(workspace, BINDING))
    assert.deepEqual(outcome, { kind: 'bound', manifest: BINDING })

    assert.deepEqual(
      await readDirectorySettings(workspace),
      { sorting: 'name-up', project: null, icon: null, color: null, quartoManifest: BINDING },
      'the dotfile names where the manifest is and holds nothing the manifest says'
    )

    const bound = await parseDirectory(workspace)
    assert.equal(bound.settings.quartoManifest, BINDING)
    assert.equal(quartoManifest(bound.settings.project).path, path.join(workspace, BINDING))
    assert.equal(bound.settings.project?.title, 'Writing', 'the title comes from the bound manifest')
  })

  it('re-reads the manifest on every load, so a stale project in the dotfile cannot shadow it', async function () {
    const stale: ProjectSettings = {
      manifest: {
        kind: 'quarto',
        path: path.join(workspace, BINDING),
        bibliographies: [],
        navigation: [{ kind: 'chapter', path: path.join(workspace, 'index.md') }]
      },
      title: 'A title the manifest has not said since',
      profiles: [],
      files: [path.join(workspace, 'index.md')],
      cslStyle: '',
      templates: { tex: '', html: '' }
    }
    await writeFile(
      path.join(workspace, '.ztr-directory'),
      JSON.stringify({ sorting: 'name-up', project: stale, icon: null, color: null, quartoManifest: BINDING }),
      'utf8'
    )

    const directory = await parseDirectory(workspace)

    assert.equal(directory.settings.project?.title, 'Writing', 'the manifest owns the title')
    assert.equal(
      quartoManifest(directory.settings.project).navigation.length,
      3,
      'the manifest owns the chapter order: one chapter and two parts'
    )
  })

  it('names every chapter by the file the assembly symlinks reach, not by the link beside the manifest', async function () {
    const directory = await parseDirectory(workspace)
    await bindQuartoManifest(directory, path.join(workspace, BINDING))
    const prose = realpathSync(workspace)

    assert.deepEqual(quartoManifest(directory.settings.project).navigation, [
      { kind: 'chapter', path: path.join(prose, 'index.md') },
      {
        kind: 'part',
        title: 'Category theory',
        chapters: [ path.join(prose, 'category-theory', 'framework', 'Bilinear-and-Quadratic-Forms.md') ]
      },
      {
        kind: 'part',
        title: 'Coble surfaces',
        chapters: [ path.join(prose, 'coble', 'lattices-and-moduli', 'coble-lattice-table.md') ]
      }
    ])
    assert.deepEqual(directory.settings.project?.files, [
      path.join(prose, 'index.md'),
      path.join(prose, 'category-theory', 'framework', 'Bilinear-and-Quadratic-Forms.md'),
      path.join(prose, 'coble', 'lattices-and-moduli', 'coble-lattice-table.md')
    ])
    assert.deepEqual(
      quartoManifest(directory.settings.project).bibliographies,
      [ path.join(prose, 'references.bib') ],
      'the bibliography the manifest inherits is the one file it names, reached through the assembly'
    )
  })

  it('refuses a manifest outside the directory, and one that is not a file', async function () {
    const directory = await parseDirectory(workspace)
    const outside = path.resolve(workspace, '..', '_quarto.yml')
    await writeFile(outside, 'project:\n  type: book\n', 'utf8')

    assert.deepEqual(
      await bindQuartoManifest(directory, outside),
      { kind: 'rejected', reason: 'outside-directory' },
      'a chapter of a manifest above the workspace would fall outside it'
    )
    assert.deepEqual(
      await bindQuartoManifest(directory, path.join(workspace, '.book')),
      { kind: 'rejected', reason: 'not-a-file' }
    )
    assert.equal(directory.settings.quartoManifest, null, 'a refused binding leaves the directory unbound')
    assert.equal(directory.settings.project, null)
  })

  it('drops the project with the binding when the workspace is unbound', async function () {
    const directory = await parseDirectory(workspace)
    await bindQuartoManifest(directory, path.join(workspace, BINDING))

    await unbindQuartoManifest(directory)

    assert.equal(directory.settings.quartoManifest, null)
    assert.equal(directory.settings.project, null, 'the derived project goes with the binding it came from')
    const reloaded = await parseDirectory(workspace)
    assert.equal(reloaded.settings.project, null, 'and it does not come back on the next load')
  })
})
