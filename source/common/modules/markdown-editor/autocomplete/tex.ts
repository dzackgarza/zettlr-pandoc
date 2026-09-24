import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource
} from '@codemirror/autocomplete'
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
  texCommandSurface,
  type TexDocumentKind,
  type TexMacroSource
} from '@common/util/tex-context'
import {
  buildTexCommandAuthority,
  type TexCommandAuthority,
  type TexstudioCommandIndex
} from '@common/util/texstudio-command-index'
import { withCompletionSource } from './completion-presentation'

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

function completionInfo (
  command: string,
  knowledge: ResolvedTexKnowledge
): string {
  if (knowledge.userCommands.has(command)) {
    return command + '\n\nUser-defined TeX macro active in this document or a declared macro source.'
  }
  const active = (knowledge.authority.providersByCommand.get(command) ?? [])
    .filter(provider => knowledge.authority.activePackages.has(provider))
  return active.length === 0
    ? command + '\n\nTeX/LaTeX core command.'
    : command + '\n\nProvided by active package' + (active.length === 1 ? ': ' : 's: ') + active.join(', ')
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
  const options: Completion[] = [...knowledge.authority.activeCommands].map(command => withCompletionSource({
    label: command,
    apply: command,
    type: 'function',
    detail: completionDetail(command, knowledge),
    info: completionInfo(command, knowledge),
    boost: knowledge.userCommands.has(command) ? 50 : undefined
  }, knowledge.userCommands.has(command) ? 'Macro' : 'LaTeX'))

  return {
    from: word.from,
    options,
    validFor: /^\\[A-Za-z@]*$/u
  }
}

/** TeX knowledge state shared by Markdown, LaTeX and Pandoc-YAML editors. */
export function texKnowledgeExtensions (kind: TexDocumentKind): Extension[] {
  return [
    texDocumentKind.of(kind),
    texMacroSourcesField
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
