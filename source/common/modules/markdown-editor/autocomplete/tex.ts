import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource
} from '@codemirror/autocomplete'
import { linter, type Diagnostic } from '@codemirror/lint'
import {
  Facet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension
} from '@codemirror/state'
import indexJson from '@common/data/texstudio-command-index.json'
import {
  collectTexContext,
  texCommandMayStartAt,
  texCommandOccurrences,
  texCommandSurface,
  type TexDocumentKind,
  type TexMacroSource
} from '@common/util/tex-context'
import {
  buildTexCommandAuthority,
  classifyTexCommand,
  type TexCommandAuthority,
  type TexstudioCommandIndex
} from '@common/util/texstudio-command-index'

const texstudioIndex = indexJson as TexstudioCommandIndex

export const texDocumentKind = Facet.define<TexDocumentKind, TexDocumentKind>({
  combine: kinds => kinds[0] ?? 'markdown'
})

export const texMacroSourcesUpdate = StateEffect.define<readonly TexMacroSource[]>()

export const texMacroSourcesField = StateField.define<readonly TexMacroSource[]>({
  create: () => [],
  update (value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(texMacroSourcesUpdate)) {
        return effect.value
      }
    }
    return value
  }
})

interface ResolvedTexKnowledge {
  authority: TexCommandAuthority
  userCommands: ReadonlySet<string>
}

function resolveKnowledge (state: EditorState): ResolvedTexKnowledge {
  const source = state.doc.toString()
  const declaration = collectTexContext(
    texstudioIndex,
    source,
    state.facet(texDocumentKind),
    state.field(texMacroSourcesField)
  )
  const baseAuthority = buildTexCommandAuthority(
    texstudioIndex,
    [ ...declaration.packages, ...declaration.classes ]
  )
  const activeCommands = new Set(baseAuthority.activeCommands)
  for (const command of declaration.userCommands) {
    activeCommands.add(command)
  }
  return {
    authority: {
      activePackages: baseAuthority.activePackages,
      activeCommands,
      providersByCommand: baseAuthority.providersByCommand
    },
    userCommands: new Set(declaration.userCommands)
  }
}

function commandVisibleAt (context: CompletionContext, from: number): boolean {
  const source = context.state.doc.toString()
  const kind = context.state.facet(texDocumentKind)
  const visible = texCommandSurface(source, kind)
  return texCommandMayStartAt(source, from) &&
    visible.slice(from, context.pos) === source.slice(from, context.pos)
}

function completionDetail (
  command: string,
  knowledge: ResolvedTexKnowledge
): string {
  if (knowledge.userCommands.has(command)) {
    return '[user macro]'
  }
  const active = (knowledge.authority.providersByCommand.get(command) ?? [])
    .filter(provider => knowledge.authority.activePackages.has(provider))
  return active.length === 0 ? '[TeX core]' : '[' + active.slice(0, 3).join(', ') + ']'
}

export const texCommandCompletionSource: CompletionSource = (
  context: CompletionContext
): CompletionResult|null => {
  const word = context.matchBefore(/\\[A-Za-z@]*$/u)
  if (word === null || !commandVisibleAt(context, word.from)) {
    return null
  }
  if (!context.explicit && word.to - word.from < 2) {
    return null
  }

  const knowledge = resolveKnowledge(context.state)
  const options: Completion[] = [...knowledge.authority.activeCommands].map(command => ({
    label: command,
    apply: command,
    type: 'function',
    detail: completionDetail(command, knowledge),
    boost: knowledge.userCommands.has(command) ? 50 : undefined
  }))

  return {
    from: word.from,
    options,
    validFor: /^\\[A-Za-z@]*$/u
  }
}

export interface TexCommandDiagnostic extends Diagnostic {
  data:
    | { kind: 'unknown' }
    | { kind: 'inactive-package', providers: readonly string[] }
}

export function texCommandDiagnostics (state: EditorState): TexCommandDiagnostic[] {
  const source = state.doc.toString()
  const kind = state.facet(texDocumentKind)
  const knowledge = resolveKnowledge(state)
  const diagnostics: TexCommandDiagnostic[] = []

  for (const occurrence of texCommandOccurrences(source, kind)) {
    const classification = classifyTexCommand(occurrence.command, knowledge.authority)
    if (classification.kind === 'active') {
      continue
    }
    if (classification.kind === 'inactive-package') {
      diagnostics.push({
        from: occurrence.from,
        to: occurrence.to,
        severity: 'info',
        source: 'tex-command',
        message: occurrence.command + ' is known to TeXstudio, but its providing package is not active.',
        data: {
          kind: 'inactive-package',
          providers: classification.providers
        }
      })
    } else {
      diagnostics.push({
        from: occurrence.from,
        to: occurrence.to,
        severity: 'info',
        source: 'tex-command',
        message: occurrence.command + ' is not declared by an active user macro or the indexed TeXstudio CWL corpus.',
        data: { kind: 'unknown' }
      })
    }
  }
  return diagnostics
}

export const texCommandLint = linter(view => texCommandDiagnostics(view.state))

/** State/lint layer shared by Markdown, LaTeX and Pandoc-YAML editors. */
export function texKnowledgeExtensions (kind: TexDocumentKind): Extension[] {
  return [
    texDocumentKind.of(kind),
    texMacroSourcesField,
    texCommandLint
  ]
}

/** Standalone completion UI for non-Markdown editors. */
export const texCommandAutocomplete = autocompletion({
  activateOnTyping: true,
  selectOnOpen: true,
  closeOnBlur: true,
  maxRenderedOptions: 20,
  override: [ texCommandCompletionSource ],
  defaultKeymap: false
})
