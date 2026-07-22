/**
 * Mounts the production Mod-P ReferenceSearchOverlay Vue component with a
 * real workspace snapshot for the Chromium input probe
 * (reference-search-overlay-probe.cjs).
 *
 * The probe delivers the raw fixture documents; this entry runs the REAL
 * extractor over them, mounts the overlay with the resulting workspace
 * definitions, and records every jump intent the component emits. The
 * component is resolved through a webpack context so that its ABSENCE is a
 * structured, reportable state (the Phase 3b red) instead of a bundler
 * crash: the probe forwards `componentFailure` into the result JSON and the
 * spec fails on assertions.
 *
 * Component contract exercised here (locked red by
 * test/reference-search-overlay.spec.ts):
 *
 * - default export of source/win-main/ReferenceSearchOverlay.vue
 * - props: { definitions: ReferenceDefinition[] } — the full workspace
 *   definition list; the component ranks them with
 *   searchWorkspaceDefinitions() as the user types
 * - the overlay autofocuses its query <input> on mount, so real keyboard
 *   input lands in it without programmatic focus
 * - every result row element carries data-reference-key and
 *   data-reference-path attributes and shows `Type — title`, key, and path
 * - Enter (or click) on the selected row emits a 'jump' event whose payload
 *   is { key, documentPath, range } for the chosen definition (the
 *   documents-provider open-file + selection jump PRECISION lands in
 *   Phase 5; the emitted intent object is the assertion target now)
 */

import { createApp, nextTick } from 'vue'
import { extractReferences } from 'source/common/pandoc-util/extract-references'
import type { ReferenceDefinition, ReferenceOccurrence, SourceRange } from '@dts/common/references'

interface ProbeDocument {
  path: string
  content: string
}

interface JumpIntent {
  key: string
  documentPath: string
  range: SourceRange
}

interface MountReport {
  componentAvailable: boolean
  componentFailure: string|null
  expectedIntent: JumpIntent|null
}

interface ProbeRow {
  key: string|null
  documentPath: string|null
  text: string
}

/** One expected citing location, computed with the real extractor. */
interface CitingLocation {
  documentPath: string
  range: SourceRange
  clusterRaw: string
}

interface KeyedMountReport {
  componentAvailable: boolean
  componentFailure: string|null
  expectedCitingLocations: CitingLocation[]
}

interface KeyedProbeRow {
  documentPath: string|null
  from: number|null
  text: string
}

declare global {
  interface Window {
    referenceSearchProbeMount: (documents: ProbeDocument[]) => Promise<MountReport>
    referenceSearchProbeState: () => { query: string|null, rows: ProbeRow[] }
    referenceSearchProbeJumpIntents: () => JumpIntent[]
    referenceSearchProbeMountKeyed: (documents: ProbeDocument[], key: string) => Promise<KeyedMountReport>
    referenceSearchProbeKeyedState: () => { query: string|null, mode: string|null, rows: KeyedProbeRow[] }
  }
}

// Resolved through a context (not a static import) so the bundle builds and
// reports structured absence while the component does not exist yet.
const overlayContext = require.context('../source/win-main/', false, /ReferenceSearchOverlay\.vue$/)

const recordedJumpIntents: JumpIntent[] = []

window.referenceSearchProbeMount = async (documents: ProbeDocument[]): Promise<MountReport> => {
  const definitions: ReferenceDefinition[] = documents
    .flatMap(document => extractReferences(document.path, document.content).definitions)

  const target = definitions.find(definition => definition.key === 'lem:kodaira:embedding')
  const expectedIntent: JumpIntent|null = target === undefined
    ? null
    : { key: target.key, documentPath: target.documentPath, range: target.range }

  const overlayKey = overlayContext.keys().find(key => key.includes('ReferenceSearchOverlay'))
  if (overlayKey === undefined) {
    return {
      componentAvailable: false,
      componentFailure: 'source/win-main/ReferenceSearchOverlay.vue does not exist yet (issue #1 Phase 3b red)',
      expectedIntent
    }
  }

  const overlayModule = overlayContext(overlayKey) as { default?: unknown }
  if (overlayModule.default === undefined) {
    return {
      componentAvailable: false,
      componentFailure: 'ReferenceSearchOverlay.vue exists but has no default component export',
      expectedIntent
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createApp(overlayModule.default as any, {
    definitions,
    onJump: (intent: JumpIntent) => { recordedJumpIntents.push(intent) }
  }).mount('#app')

  await nextTick()
  await document.fonts.ready
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

  return { componentAvailable: true, componentFailure: null, expectedIntent }
}

window.referenceSearchProbeState = () => {
  const input = document.querySelector<HTMLInputElement>('.reference-search-overlay input')
  const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-reference-key]'))
  return {
    query: input?.value ?? null,
    rows: rows.map(row => ({
      key: row.getAttribute('data-reference-key'),
      documentPath: row.getAttribute('data-reference-path'),
      text: row.textContent ?? ''
    }))
  }
}

window.referenceSearchProbeJumpIntents = () => recordedJumpIntents

/**
 * The Phase 8 reverse-lookup scene (issue #1 Phase 4 badge contract): a
 * definition's `N references` count badge dispatches
 * openReferenceSearchEffect.of({ key }) and the overlay must open PRE-KEYED
 * on that definition, presenting the workspace CITING LOCATIONS of exactly
 * that key — occurrence rows with contextual snippets and jump actions —
 * instead of the definition list.
 *
 * Component contract exercised here (locked red by the keyed specs in
 * test/reference-search-overlay.spec.ts):
 *
 * - props gain: {
 *     occurrences: ReferenceOccurrence[]  — the merged workspace occurrence
 *                                           list (the same data MainEditor
 *                                           already aggregates as
 *                                           workspaceOccurrences),
 *     initialRequest: ReferenceSearchRequest — the relayed effect payload:
 *                                           null keeps today's definition
 *                                           search; { key } opens the
 *                                           reverse lookup
 *   }
 * - the overlay root carries data-search-mode='definitions' |
 *   'citing-locations'
 * - a keyed request pre-populates the query input with the key
 * - in citing-locations mode every row is an OCCURRENCE row carrying
 *   data-occurrence-path and data-occurrence-from, showing the authored
 *   cluster snippet and the citing document's path, listed in workspace
 *   document order
 * - Enter (or click) on a row emits a 'jump' intent
 *   { key, documentPath, range } for that CITING LOCATION (the occurrence's
 *   exact authored range, not the definition's)
 */
window.referenceSearchProbeMountKeyed = async (documents: ProbeDocument[], key: string): Promise<KeyedMountReport> => {
  const snapshots = documents.map(document => extractReferences(document.path, document.content))
  const definitions: ReferenceDefinition[] = snapshots.flatMap(snapshot => snapshot.definitions)
  const occurrences: ReferenceOccurrence[] = snapshots.flatMap(snapshot => snapshot.occurrences)

  const expectedCitingLocations: CitingLocation[] = occurrences
    .filter(occurrence => occurrence.key === key)
    .map(occurrence => ({
      documentPath: occurrence.documentPath,
      range: occurrence.range,
      clusterRaw: occurrence.clusterRaw
    }))

  const overlayKey = overlayContext.keys().find(contextKey => contextKey.includes('ReferenceSearchOverlay'))
  if (overlayKey === undefined) {
    return {
      componentAvailable: false,
      componentFailure: 'source/win-main/ReferenceSearchOverlay.vue does not exist yet (issue #1 Phase 3b red)',
      expectedCitingLocations
    }
  }

  const overlayModule = overlayContext(overlayKey) as { default?: unknown }
  if (overlayModule.default === undefined) {
    return {
      componentAvailable: false,
      componentFailure: 'ReferenceSearchOverlay.vue exists but has no default component export',
      expectedCitingLocations
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createApp(overlayModule.default as any, {
    definitions,
    occurrences,
    initialRequest: { key },
    onJump: (intent: JumpIntent) => { recordedJumpIntents.push(intent) }
  }).mount('#app')

  await nextTick()
  await document.fonts.ready
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

  return { componentAvailable: true, componentFailure: null, expectedCitingLocations }
}

window.referenceSearchProbeKeyedState = () => {
  const overlay = document.querySelector<HTMLElement>('.reference-search-overlay')
  const input = document.querySelector<HTMLInputElement>('.reference-search-overlay input')
  const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-occurrence-path]'))
  return {
    query: input?.value ?? null,
    mode: overlay?.getAttribute('data-search-mode') ?? null,
    rows: rows.map(row => {
      const from = row.getAttribute('data-occurrence-from')
      return {
        documentPath: row.getAttribute('data-occurrence-path'),
        from: from === null ? null : Number(from),
        text: row.textContent ?? ''
      }
    })
  }
}
