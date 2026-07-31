/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Combined @-symbol Autocomplete
 * CVM-Role:        Autocomplete Plugin
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The combined `@` completion surface of issue #1 (Phase 3):
 *                  one provider that preserves bibliography citation
 *                  completion exactly and appends typed workspace reference
 *                  label entries.
 *
 *                  DELEGATION CONTRACT (locked by
 *                  test/editor-reference-completion.spec.ts):
 *
 *                  - applies(ctx) returns exactly citations.applies(ctx).
 *                    The trigger surface of the `@` completion is
 *                    byte-identical to today's citation provider; contexts
 *                    that do not trigger citation completion today never
 *                    trigger the combined surface either.
 *                  - entries(ctx, query) returns exactly the array elements
 *                    citations.entries(ctx, query) returns — the same
 *                    Completion objects, in the same order, with the same
 *                    apply handler — followed by the appended label entries
 *                    derived from referencesUpdateField.
 *                  - A label entry presents `label = key` and
 *                    `detail = '<Type> — <title>'` (the family display name,
 *                    an em-dash, and the authored title), or the bare family
 *                    display name when no title was authored. Filtering is
 *                    the same case-insensitive substring test over label and
 *                    detail that the citation provider applies.
 *                  - Applying a label entry inserts the bare key text over
 *                    the completion range: it never wraps the insertion in
 *                    brackets and never rewrites the authored `@` or an
 *                    authored bracket cluster.
 *                  - projectStatus never gates, reorders, or restyles label
 *                    entries; it feeds only the typed insertion affordance.
 *                  - citations.ts stays untouched: this provider replaces
 *                    `citations` in the first-match array of
 *                    autocomplete/index.ts and delegates to it verbatim.
 *
 * END HEADER
 */

import { type Completion } from '@codemirror/autocomplete'
import { StateEffect, StateField } from '@codemirror/state'
import { type EditorView } from '@codemirror/view'
import { referenceFamilyDisplayName, type AppendAndContinuePlan, type ReferenceCompletionEntry } from '@dts/common/references'
import { type ProjectSettings } from '@dts/common/fsal'
import {
  applyAppendPlan,
  appendToastMessage,
  completionAffordanceFor,
  type CompletionInsertionAffordance
} from '@common/pandoc-util/project-reference-status'
import showToast from '@common/util/show-toast'
import { trans } from '@common/i18n-renderer'
import { runRecoverably } from '@common/util/run-recoverably'
import { requestPandocQuickHelp } from '../plugins/pandoc-quick-help-effect'
import { type AutocompletePlugin } from '.'
import { citations, citekeyUpdateField } from './citations'

/**
 * Use this effect to provide the editor state with a new set of workspace
 * reference label entries (the 'references' completion database).
 */
export const referencesUpdate = StateEffect.define<ReferenceCompletionEntry[]>()

export const referencesUpdateField = StateField.define<ReferenceCompletionEntry[]>({
  create (_state) {
    return []
  },
  update (val, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(referencesUpdate)) {
        return effect.value
      }
    }
    return val
  }
})

/**
 * A label option on the combined surface: a Completion exposing its typed
 * insertion affordance as `referenceAffordance` (issue #1 Phase 7). Citation
 * options never carry this property.
 */
interface ReferenceLabelCompletion extends Completion {
  referenceAffordance: CompletionInsertionAffordance
}

/**
 * The editor view of the current completion session (review A2). The
 * production autocomplete source constructs its CompletionContext WITH the
 * view; synchronous CompletionResult.update calls construct it without one,
 * so entries() records the last seen view here for the info panel's
 * quick-help link — the panel DOM outlives the context that created it.
 */
let lastCompletionView: EditorView|undefined

/**
 * Builds a label option's info panel: the US-06 "help from completion"
 * entry point. Beside the option's display detail it renders a quick-help
 * link that dispatches openPandocQuickHelpEffect on the inviting view (the
 * MarkdownEditor re-emits the effect and App.vue mounts PandocQuickHelp).
 *
 * @param   {string}  detail  The option's `Type — title` display text
 *
 * @return  {HTMLElement}     The info panel element
 */
function labelInfoPanel (detail: string): HTMLElement {
  const panel = document.createElement('div')
  panel.className = 'reference-completion-info'

  const description = document.createElement('div')
  description.textContent = detail
  panel.appendChild(description)

  const link = document.createElement('button')
  link.type = 'button'
  link.setAttribute('data-open-help', '')
  link.textContent = 'Pandoc quick reference…'
  link.style.cssText = 'margin-top: 6px; padding: 0; color: inherit; background: none; border: none; font: inherit; text-decoration: underline; cursor: pointer'
  link.addEventListener('click', () => {
    const view = lastCompletionView
    if (view === undefined) {
      // The panel cannot exist without a completion session having seen a
      // view; reaching this state is a protocol violation, not a fallback.
      throw new Error('Pandoc quick-help link clicked outside a completion session')
    }
    requestPandocQuickHelp(view)
  })
  panel.appendChild(link)

  return panel
}

/**
 * The locked `Type — title` display text of a label entry, or the bare
 * family display name when no title was authored. The display name comes
 * from the single shared authority (referenceFamilyDisplayName).
 *
 * @param   {ReferenceCompletionEntry}  entry  The label entry
 *
 * @return  {string}                           The detail display text
 */
function labelDetail (entry: ReferenceCompletionEntry): string {
  return entry.title !== undefined
    ? `${referenceFamilyDisplayName(entry.family)} — ${entry.title}`
    : referenceFamilyDisplayName(entry.family)
}

/**
 * Applies a label completion: the bare key text replaces the completion
 * range. This never wraps the insertion in brackets and never rewrites the
 * authored `@` or an authored bracket cluster.
 */
const applyLabel = function (view: EditorView, completion: Completion, from: number, to: number): void {
  const insert = String(completion.label)
  view.dispatch({ changes: [{ from, to, insert }], selection: { anchor: from + insert.length } })
}

/**
 * A disabled label completion: another-Project targets stay visible on the
 * surface but are inert for insertion — applying one changes nothing.
 */
const applyDisabled = function (_view: EditorView, _completion: Completion, _from: number, _to: number): void {
  // Insertion is disabled for another-Project entries.
}

/**
 * Runs the mechanical append-and-continue plan through the EXISTING
 * dir-settings surface: fetch the Project root's descriptor, apply the plan
 * to its ProjectSettings (applyAppendPlan), push the result through the
 * 'update-project-properties' command (-> FSAL.updateProject()), and confirm
 * with one toast naming every appended file. No new ipc channel, no dialog.
 *
 * @param   {AppendAndContinuePlan}  plan  The plan carried by the applied option
 */
async function runAppendAndContinue (plan: AppendAndContinuePlan): Promise<void> {
  // window.ipc is the production preload bridge, present in every renderer
  // window; the headless completion specs provision the same seam.
  const descriptor = await window.ipc.invoke('fsal', {
    command: 'get-descriptor',
    payload: plan.rootPath
  })

  if (descriptor === undefined || Array.isArray(descriptor) || descriptor.type !== 'directory') {
    throw new Error(`Cannot append to the Project at ${plan.rootPath}: the path is not a workspace directory`)
  }

  const settings: ProjectSettings|null = descriptor.settings.project
  if (settings === null) {
    throw new Error(`Cannot append to the Project at ${plan.rootPath}: the directory carries no Project settings`)
  }

  await window.ipc.invoke('application', {
    command: 'update-project-properties',
    payload: { path: plan.rootPath, properties: applyAppendPlan(settings, plan) }
  })

  showToast(appendToastMessage(plan))
}

/**
 * The apply handler for one typed insertion affordance: disabled entries are
 * inert, append-carrying entries insert the bare key and CONTINUE with the
 * mechanical append (production renderer window only), and everything else
 * is the unchanged bare-key insertion.
 *
 * @param   {CompletionInsertionAffordance}  affordance  The option's affordance
 *
 * @return  {typeof applyLabel}                          The apply handler
 */
function applyFor (affordance: CompletionInsertionAffordance): typeof applyLabel {
  if (affordance.kind === 'disabled-another-project') {
    return applyDisabled
  }

  if (affordance.kind === 'insert-with-append') {
    return function (view: EditorView, completion: Completion, from: number, to: number): void {
      applyLabel(view, completion, from, to)
      // The append continuation surfaces failures through the recoverable
      // boundary (review B8): one closable error toast, never a silent
      // console-only line. The insertion above already happened either way.
      void runRecoverably(async () => { await runAppendAndContinue(affordance.plan) }, trans('Appending to the Project'))
    }
  }

  return applyLabel
}

/**
 * The combined `@` completion surface: bibliography citation completion,
 * delegated verbatim to the citations provider, followed by the typed
 * workspace reference label entries of the 'references' database.
 * projectStatus never gates, reorders, or restyles label entries in Phase 3.
 */
export const atSymbols: AutocompletePlugin = {
  applies (ctx) {
    // The trigger surface is byte-identical to the citation provider's.
    return citations.applies(ctx)
  },
  entries (ctx, query) {
    query = query.toLowerCase()
    if (ctx.view !== undefined) {
      lastCompletionView = ctx.view
    }
    const labelEntries: ReferenceLabelCompletion[] = ctx.state.field(referencesUpdateField)
      .map(entry => {
        // The Phase-7 gating: the typed affordance decides HOW the entry
        // applies; it never gates visibility or label/detail presentation.
        const referenceAffordance = completionAffordanceFor(entry.projectStatus, entry.appendPlan)
        const detail = labelDetail(entry)
        return {
          label: entry.key,
          detail,
          apply: applyFor(referenceAffordance),
          // US-06 (review A2): every label option links to the searchable
          // quick help from its info panel. Citation options never carry
          // this — their objects pass through byte-identically.
          info: () => labelInfoPanel(detail),
          referenceAffordance
        }
      })
      .filter(entry => {
        // The same case-insensitive substring filter the citation provider
        // applies, over label and detail.
        return entry.label.toLowerCase().includes(query) || entry.detail.toLowerCase().includes(query)
      })

    return citations.entries(ctx, query).concat(labelEntries)
  },
  fields: [ citekeyUpdateField, referencesUpdateField ]
}
