import { strict as assert } from 'node:assert'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

describe('vendored Quiver fork', function () {
  const root = path.join(process.cwd(), 'vendor', 'quiver')

  it('pins upstream provenance and carries the MIT license locally', async function () {
    const provenance = await readFile(path.join(root, 'PROVENANCE.toml'), 'utf8')
    const license = await readFile(path.join(root, 'LICENSE'), 'utf8')
    const katexLicense = await readFile(path.join(root, 'KATEX-LICENSE.txt'), 'utf8')
    const patch = await readFile(path.join(root, 'ZETTLR.patch'), 'utf8')
    assert.match(provenance, /upstream_repository = "https:\/\/github\.com\/varkor\/quiver"/u)
    assert.match(provenance, /upstream_commit = "[0-9a-f]{40}"/u)
    assert.match(provenance, /patch_file = "ZETTLR\.patch"/u)
    assert.match(provenance, /katex_version = "0\.18\.1"/u)
    assert.match(provenance, /mode = "vendored-fork"/u)
    assert.match(license, /MIT License/u)
    assert.match(katexLicense, /MIT License/u)
    assert.match(patch, /zettlr-host\.mjs/u)
  })

  it('ships its editor host and KaTeX locally rather than embedding the hosted Quiver app', async function () {
    const host = await readFile(path.join(root, 'src', 'zettlr-host.mjs'), 'utf8')
    const html = await readFile(path.join(root, 'src', 'zettlr-host.html'), 'utf8')
    assert.match(host, /zettlr-quiver:change/u)
    assert.match(host, /\.\/ui\.mjs/u)
    assert.doesNotMatch(html, /(?:src|href)="https?:\/\//u)
    assert.doesNotMatch(host, /import\(["']https?:\/\//u)
    assert.match(html, /KaTeX\/katex\.css/u)
    assert.ok((await stat(path.join(root, 'src', 'KaTeX', 'katex.mjs'))).isFile())
  })

  it('hooks synchronization at Quiver history persistence rather than observing its DOM', async function () {
    const ui = await readFile(path.join(root, 'src', 'ui.mjs'), 'utf8')
    const host = await readFile(path.join(root, 'src', 'zettlr-host.mjs'), 'utf8')
    assert.match(ui, /zettlr-quiver-change/u)
    assert.doesNotMatch(host, /MutationObserver/u)
  })

  it('does not register Quiver web persistence/theme/about actions in host mode', async function () {
    const ui = await readFile(path.join(root, 'src', 'ui.mjs'), 'utf8')
    assert.match(ui, /__ZETTLR_QUIVER_HOST__ !== true/u)
    assert.match(ui, /"Save",\s*\n\s*"save"/u)
    assert.match(ui, /"autosave-on"/u)
    assert.match(ui, /"dark-theme"/u)
    assert.match(ui, /"About",\s*\n\s*"about"/u)
  })

  it('ships the deterministic vendor refresh command', async function () {
    const refresh = await readFile(path.join(process.cwd(), 'scripts', 'update-quiver-vendor.mjs'), 'utf8')
    assert.match(refresh, /git.*apply/su)
    assert.match(refresh, /katex\.zip/u)
    assert.match(refresh, /upstream_commit/u)
  })
})
