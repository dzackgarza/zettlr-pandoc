/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Main-window component contracts
 * CVM-Role:        Types
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Type contracts shared between main-window components.
 *                  These previously lived inside the SFC modules that
 *                  motivated them (App.vue, MainEditor.vue,
 *                  ReferenceSearchOverlay.vue), but plain tsc — which powers
 *                  type-aware linting — cannot resolve types exported from
 *                  .vue modules (it reads the raw SFC text, template
 *                  included, as TypeScript), while vue-tsc virtualizes SFCs
 *                  and can. Cross-component contracts therefore live in this
 *                  plain module, which both toolchains resolve identically
 *                  (issue #50).
 *
 * END HEADER
 */

import type {
  ConfirmReferenceLabelOutcome,
  CreateReferenceLabelIntent,
  CreateReferenceLabelRequest,
} from "@common/modules/markdown-editor/plugins/create-reference-label";

/**
 * The payload accompanying an editor command: which shape applies is decided
 * by whichever command toggle was flipped alongside it (see EditorCommands).
 */
export type EditorCommandData =
  | string
  | { filePath: string; lineNumber: number }
  | { from: number; to: number }
  | { type: string; attributes: string }
  | undefined;

/**
 * Okay, hear me out. We have the following situation: We have a toolbar, and
 * external components that want to tell the main editor to do something. But
 * Vue doesn't have a concept of events being passed down to child components
 * and since editors may now be nested arbitrarily deep, we have no direct way
 * of accessing the editors and tell them to do something. Basically, Vue's data
 * flow goes like this: Events flow up, and props flow down. That's it. So we're
 * using this hacky solution "misusing" props as events. This interface
 * represents all the potential editor commands that can be issued. The last
 * property can contain arbitrary data if required by the command. We'll be
 * passing this struct as a prop down to every EditorBranch and EditorPane into
 * the main editor components. Every editor instance then listens to these
 * events by watching property changes (i.e. when moveSection switches from true
 * to false) and testing if they are the last editor (the only identifying info
 * we can store in the state to not break things due to Vue's aggressive
 * reactivity). Then, the editors can act based on this info.
 *
 * One example:
 * 1. The app receives a jump to line-command. It then writes the necessary info
 *    (in this case, which line to jump to) into the `data` prop. That is not
 *    watched by the editors, but since it's part of the data structure, it will
 *    silently update in the background.
 * 2. Then, the app switches the jumpToLine-property (false->true or otherwise).
 *    Since that sub-property is being watched by the editors, it will trigger
 *    the watcher that then checks the lastLeafId in the state. If that
 *    corresponds to the editor's leaf ID, the editor calls the appropriate
 *    function locally, and executes the command, providing the data.
 */
export interface EditorCommands {
  jumpToLine: boolean;
  moveSection: boolean;
  addKeywords: boolean;
  replaceSelection: boolean;
  insertPandoc: boolean;
  executeCommand: boolean;
  data: EditorCommandData;
}

/**
 * The state of the toolbar's pomodoro timer, shared between App.vue (which
 * runs the timer) and PopoverPomodoro.vue (which displays and configures it).
 */
export interface PomodoroConfig {
  currentEffectFile: string;
  soundEffect: HTMLAudioElement;
  intervalHandle: ReturnType<typeof setInterval> | undefined;
  durations: {
    task: number;
    short: number;
    long: number;
  };
  phase: {
    type: "task" | "short" | "long";
    elapsed: number;
  };
  counter: {
    task: number;
    short: number;
    long: number;
  };
  colour: {
    task: string;
    short: string;
    long: string;
  };
}

/**
 * The relayed create-label request App.vue mounts the dialog over: the
 * context-fixed family, the editable slug proposal, and the closure that
 * performs the insertion in the invoking editor once the dialog confirms a
 * key (clipboard write and toast are App.vue's half). The closure re-resolves
 * the target against the CURRENT document at confirm time (issue #1 Phase 8:
 * confirmReferenceLabelInsertion) and returns the typed outcome — a stale
 * outcome means NOTHING was inserted and App.vue surfaces it as a closable
 * toast.
 */
export interface CreateReferenceLabelDialogPrompt {
  family: CreateReferenceLabelRequest["family"];
  proposedSlug: string;
  applyCreate: (intent: CreateReferenceLabelIntent) => ConfirmReferenceLabelOutcome;
}

/**
 * The navigation intent the reference search overlay emits for a chosen
 * definition or citing occurrence.
 */
export interface ReferenceJumpIntent {
  key: string;
  documentPath: string;
  range: { from: number; to: number };
}
