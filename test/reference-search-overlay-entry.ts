/**
 * Mounts the production ReferenceSearchView (the launcher's reference search) with a
 * real workspace snapshot for the Chromium input probe
 * (reference-search-overlay-probe.mjs).
 *
 * The probe delivers the raw fixture documents; this entry runs the REAL
 * extractor over them, mounts the overlay with the resulting workspace
 * definitions, and records every jump intent the component emits.
 *
 * Component contract exercised here (locked red by
 * test/reference-search-overlay.spec.ts):
 *
 * - default export of source/win-main/launcher/ReferenceSearchView.vue
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

import "./provision-renderer-window-seams";

import type {
  ProjectRootSpec,
  ReferenceDefinition,
  ReferenceOccurrence,
  SourceRange,
} from "@dts/common/references";
import { createPinia } from "pinia";
import { extractReferences } from "source/common/pandoc-util/extract-references";
import ReferenceSearchView from "source/win-main/launcher/ReferenceSearchView.vue";
import { createApp, nextTick } from "vue";

interface ProbeDocument {
  path: string;
  content: string;
}

/** The US-16 ranking context of the plain scene (review A3). */
interface ProbeSearchContext {
  activeDocumentPath: string;
  projectRoots: ProjectRootSpec[];
}

interface JumpIntent {
  key: string;
  documentPath: string;
  range: SourceRange;
}

interface MountReport {
  componentAvailable: boolean;
  componentFailure: string | null;
  expectedIntent: JumpIntent | null;
}

interface ProbeRow {
  key: string | null;
  documentPath: string | null;
  /** The row's Project marker status attribute (review A3), if marked */
  projectStatus: string | null;
  text: string;
}

/** One expected citing location, computed with the real extractor. */
interface CitingLocation {
  documentPath: string;
  range: SourceRange;
  clusterRaw: string;
}

interface KeyedMountReport {
  componentAvailable: boolean;
  componentFailure: string | null;
  expectedCitingLocations: CitingLocation[];
}

interface KeyedProbeRow {
  documentPath: string | null;
  from: number | null;
  text: string;
}

declare global {
  interface Window {
    referenceSearchProbeMount: (
      documents: ProbeDocument[],
      context?: ProbeSearchContext,
    ) => Promise<MountReport>;
    referenceSearchProbeState: () => {
      query: string | null;
      helpAffordancePresent: boolean;
      rows: ProbeRow[];
    };
    referenceSearchProbeJumpIntents: () => JumpIntent[];
    referenceSearchProbeOpenHelpCount: () => number;
    referenceSearchProbeMountKeyed: (
      documents: ProbeDocument[],
      key: string,
    ) => Promise<KeyedMountReport>;
    referenceSearchProbeKeyedState: () => {
      query: string | null;
      mode: string | null;
      rows: KeyedProbeRow[];
    };
    referenceSearchProbeOverlayPresent: () => boolean;
  }
}

const recordedJumpIntents: JumpIntent[] = [];
/** Every 'open-help' emission of the overlay (review A2, US-06). */
let recordedOpenHelpCount = 0;

window.referenceSearchProbeMount = async (
  documents: ProbeDocument[],
  context?: ProbeSearchContext,
): Promise<MountReport> => {
  const definitions: ReferenceDefinition[] = documents.flatMap(
    (document) => extractReferences(document.path, document.content).definitions,
  );

  const target = definitions.find((definition) => definition.key === "lem:kodaira:embedding");
  const expectedIntent: JumpIntent | null =
    target === undefined
      ? null
      : { key: target.key, documentPath: target.documentPath, range: target.range };

  const overlayApp = createApp(ReferenceSearchView, {
    definitions,
    projectRoots: context?.projectRoots ?? [],
    activeDocumentPath: context?.activeDocumentPath,
    onJump: (intent: JumpIntent) => {
      recordedJumpIntents.push(intent);
      // Mirror the overlay's OWNER (App.vue): its jump handler sets
      // showReferenceSearch to false and closes the overlay, so the probe's
      // post-Enter frame shows the real closed state (ledger C4).
      overlayApp.unmount();
    },
    onOpenHelp: () => {
      recordedOpenHelpCount++;
    },
  });
  overlayApp.use(createPinia()).mount("#app");

  await nextTick();
  await document.fonts.ready;
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

  return { componentAvailable: true, componentFailure: null, expectedIntent };
};

window.referenceSearchProbeState = () => {
  const input = document.querySelector<HTMLInputElement>(".reference-search-view input");
  const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-reference-key]"));
  return {
    query: input?.value ?? null,
    helpAffordancePresent:
      document.querySelector(".reference-search-view [data-open-help]") !== null,
    rows: rows.map((row) => ({
      key: row.getAttribute("data-reference-key"),
      documentPath: row.getAttribute("data-reference-path"),
      projectStatus: row.getAttribute("data-project-status"),
      text: row.textContent ?? "",
    })),
  };
};

window.referenceSearchProbeJumpIntents = () => recordedJumpIntents;

window.referenceSearchProbeOpenHelpCount = () => recordedOpenHelpCount;

window.referenceSearchProbeOverlayPresent = () => {
  return document.querySelector(".reference-search-view") !== null;
};

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
window.referenceSearchProbeMountKeyed = async (
  documents: ProbeDocument[],
  key: string,
): Promise<KeyedMountReport> => {
  const snapshots = documents.map((document) => extractReferences(document.path, document.content));
  const definitions: ReferenceDefinition[] = snapshots.flatMap((snapshot) => snapshot.definitions);
  const occurrences: ReferenceOccurrence[] = snapshots.flatMap((snapshot) => snapshot.occurrences);

  const expectedCitingLocations: CitingLocation[] = occurrences
    .filter((occurrence) => occurrence.key === key)
    .map((occurrence) => ({
      documentPath: occurrence.documentPath,
      range: occurrence.range,
      clusterRaw: occurrence.clusterRaw,
    }));

  const keyedApp = createApp(ReferenceSearchView, {
    definitions,
    occurrences,
    initialRequest: { key },
    onJump: (intent: JumpIntent) => {
      recordedJumpIntents.push(intent);
      // Mirror App.vue: the citing-location jump closes the overlay too.
      keyedApp.unmount();
    },
  });
  keyedApp.use(createPinia()).mount("#app");

  await nextTick();
  await document.fonts.ready;
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

  return { componentAvailable: true, componentFailure: null, expectedCitingLocations };
};

window.referenceSearchProbeKeyedState = () => {
  const overlay = document.querySelector<HTMLElement>(".reference-search-view");
  const input = document.querySelector<HTMLInputElement>(".reference-search-view input");
  const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-occurrence-path]"));
  return {
    query: input?.value ?? null,
    mode: overlay?.getAttribute("data-search-mode") ?? null,
    rows: rows.map((row) => {
      const from = row.getAttribute("data-occurrence-from");
      return {
        documentPath: row.getAttribute("data-occurrence-path"),
        from: from === null ? null : Number(from),
        text: row.textContent ?? "",
      };
    }),
  };
};
