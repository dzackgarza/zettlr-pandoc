/**
 * Responsiveness regressions: locks the ownership changes that keep hot paths
 * bounded without turning performance policy into browser-timing assertions.
 */

import { strict as assert } from 'assert'
import { readFileSync } from 'fs'
import { mergeSortedByDocumentPath } from '@common/util/merge-sorted-by-document-path'
import type { FileSearchResult } from 'source/app/service-providers/search'

function result (documentPath: string, marker: number): FileSearchResult {
  return {
    documentPath,
    sourceHash: String(marker).padStart(64, '0'),
    replaceable: true,
    matches: []
  }
}

describe('responsiveness ownership regressions', function () {
  it('merges streamed search batches in path order and lets the newest file result replace an older one', function () {
    const existing = [ result('/b.md', 1), result('/d.md', 1) ]
    const incoming = [ result('/c.md', 2), result('/b.md', 2), result('/a.md', 2) ]
    const merged = mergeSortedByDocumentPath(existing, incoming)

    assert.deepEqual(merged.map(item => item.documentPath), [ '/a.md', '/b.md', '/c.md', '/d.md' ])
    assert.equal(merged.find(item => item.documentPath === '/b.md')?.sourceHash, result('/b.md', 2).sourceHash)
  })

  it('uses one shared state field for every block renderer instead of one field per renderer', function () {
    const source = readFileSync('source/common/modules/markdown-editor/renderers/base-renderer.ts', 'utf8')
    assert.match(source, /const blockRendererFacet = Facet\.define/)
    assert.match(source, /const sharedBlockRendererField = StateField\.define<DecorationSet>/)
    const blockFactory = source.slice(source.indexOf('export function renderBlockWidgets'))
    assert.doesNotMatch(blockFactory, /StateField\.define/)
    assert.match(blockFactory, /blockRendererFacet\.of/)
    assert.match(blockFactory, /sharedBlockRendererField/)
  })

  it('unsubscribes every file-manager component listener that is registered on mount', function () {
    const tree = readFileSync('source/win-main/file-manager/TreeItem.vue', 'utf8')
    const item = readFileSync('source/win-main/file-manager/FileItem.vue', 'utf8')
    const manager = readFileSync('source/win-main/file-manager/FileManager.vue', 'utf8')

    assert.match(tree, /onUnmounted\(\(\) => \{[\s\S]*stopShortcutListener\?\.\(\)[\s\S]*stopFsalListener\?\.\(\)/)
    assert.match(item, /onUnmounted\(\(\) => \{[\s\S]*stopFsalListener\?\.\(\)/)
    assert.match(manager, /onUnmounted\(\(\) => \{[\s\S]*stopShortcutListener\?\.\(\)/)
  })

  it('virtualizes flattened search result rows instead of mounting every match at once', function () {
    const source = readFileSync('source/win-main/sidebar/SearchView.vue', 'utf8')
    assert.match(source, /<RecycleScroller[\s\S]*v-bind:items="visibleRows"[\s\S]*v-bind:item-size="SEARCH_RESULT_ROW_HEIGHT"/)
    assert.match(source, /const visibleRows = computed<SearchResultRow\[\]>/)
  })

  it('keeps descriptor collection reactivity shallow and removes the whole-map deep watcher', function () {
    const source = readFileSync('source/pinia/workspace-store.ts', 'utf8')
    assert.match(source, /const descriptorMap = shallowRef\(new Map<string, AnyDescriptor>\(\)\)/)
    assert.match(source, /triggerRef\(descriptorMap\)/)
    assert.doesNotMatch(source, /watch\(descriptorMap/)
  })

  it('keeps live citation rendering off synchronous IPC', function () {
    const source = readFileSync('source/common/modules/markdown-editor/renderers/render-citations.ts', 'utf8')
    assert.match(source, /window\.ipc\.invoke\('citeproc-provider'/)
    assert.doesNotMatch(source, /sendSync\(/)
  })
})
