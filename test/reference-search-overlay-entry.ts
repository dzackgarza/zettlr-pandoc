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
import type { ReferenceDefinition, SourceRange } from '@dts/common/references'

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

declare global {
  interface Window {
    referenceSearchProbeMount: (documents: ProbeDocument[]) => Promise<MountReport>
    referenceSearchProbeState: () => { query: string|null, rows: ProbeRow[] }
    referenceSearchProbeJumpIntents: () => JumpIntent[]
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
