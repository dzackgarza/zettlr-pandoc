import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  Facet,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  collectTexContext,
  type TexDocument,
  type TexDocumentKind,
  texCommandMayStartAt,
  texCommandSurface,
  texDocument,
} from "@common/util/tex-context";
import {
  buildTexCommandAuthority,
  type TexCommandAuthority,
} from "@common/util/texstudio-command-index";
import type { TexCommandVocabulary } from "@dts/common/tex-vocabulary";
import { withCompletionSource } from "./completion-presentation";

/**
 * The kind of document the TeX knowledge describes. CodeMirror combines an
 * unprovided facet to its default; that default is `undefined` here, because
 * an editor without texKnowledgeExtensions() has no TeX document kind.
 */
export const texDocumentKind = Facet.define<TexDocumentKind, TexDocumentKind | undefined>({
  combine: (kinds) => (kinds.length === 0 ? undefined : kinds[0]),
});

function documentKind(state: EditorState): TexDocumentKind {
  const kind = state.facet(texDocumentKind);
  if (kind === undefined) {
    throw new Error(
      "TeX completion ran in an editor without texKnowledgeExtensions(kind); install them in its extension set.",
    );
  }
  return kind;
}

export const texVocabularyUpdate = StateEffect.define<TexCommandVocabulary>();

/**
 * Flowmark's TeX vocabulary (`tex-command-vocabulary`). Until the window has
 * it, the completion offers no TeX command.
 */
export const texVocabularyField = StateField.define<TexCommandVocabulary | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(texVocabularyUpdate)) {
        return effect.value;
      }
    }
    return value;
  },
});

interface ResolvedTexKnowledge {
  authority: TexCommandAuthority;
  userCommands: ReadonlySet<string>;
}

/** The TeX document of an editor, with the syntax tree that the editor has. */
function editorTexDocument(state: EditorState): TexDocument {
  return texDocument(state.doc.toString(), documentKind(state), syntaxTree(state));
}

function resolveKnowledge(
  state: EditorState,
  vocabulary: TexCommandVocabulary,
): ResolvedTexKnowledge {
  const declaration = collectTexContext(vocabulary.index, editorTexDocument(state));
  const baseAuthority = buildTexCommandAuthority(vocabulary, declaration.roots);
  const activeCommands = new Set(baseAuthority.activeCommands);
  for (const command of declaration.userCommands) {
    activeCommands.add(command);
  }
  return {
    authority: {
      activePackages: baseAuthority.activePackages,
      activeCommands,
      providersByCommand: baseAuthority.providersByCommand,
    },
    userCommands: new Set(declaration.userCommands),
  };
}

function commandVisibleAt(context: CompletionContext, from: number): boolean {
  const document = editorTexDocument(context.state);
  const source = document.source;
  const visible = texCommandSurface(document);
  return (
    texCommandMayStartAt(source, from) &&
    visible.slice(from, context.pos) === source.slice(from, context.pos)
  );
}

/**
 * The active packages that provide a non-user command. Every such command is
 * active only because an active package declares it, so the reverse index
 * built from the same TeXstudio index always knows it.
 */
function activeProviders(command: string, knowledge: ResolvedTexKnowledge): readonly string[] {
  const providers = knowledge.authority.providersByCommand.get(command);
  if (providers === undefined) {
    throw new Error(
      `TeX command ${command} is active, but no TeXstudio provider declares it; activeCommands and providersByCommand must come from the same index.`,
    );
  }
  return providers.filter((provider) => knowledge.authority.activePackages.has(provider));
}

function completionDetail(command: string, knowledge: ResolvedTexKnowledge): string {
  if (knowledge.userCommands.has(command)) {
    return "[user macro]";
  }
  const active = activeProviders(command, knowledge);
  return active.length === 0 ? "[TeX core]" : "[" + active.slice(0, 3).join(", ") + "]";
}

function completionInfo(command: string, knowledge: ResolvedTexKnowledge): string {
  if (knowledge.userCommands.has(command)) {
    return command + "\n\nUser-defined TeX macro of this document.";
  }
  const active = activeProviders(command, knowledge);
  return active.length === 0
    ? command + "\n\nTeX/LaTeX core command."
    : command +
        "\n\nProvided by active package" +
        (active.length === 1 ? ": " : "s: ") +
        active.join(", ");
}

export const texCommandCompletionSource: CompletionSource = (
  context: CompletionContext,
): CompletionResult | null => {
  const word = context.matchBefore(/\\[A-Za-z@]*$/u);
  if (word === null || !commandVisibleAt(context, word.from)) {
    return null;
  }
  if (!context.explicit && word.to - word.from < 2) {
    return null;
  }

  const vocabulary = context.state.field(texVocabularyField);
  if (vocabulary === null) {
    return null;
  }
  const knowledge = resolveKnowledge(context.state, vocabulary);
  const options: Completion[] = [...knowledge.authority.activeCommands].map((command) =>
    withCompletionSource(
      {
        label: command,
        apply: command,
        type: "function",
        detail: completionDetail(command, knowledge),
        info: completionInfo(command, knowledge),
        boost: knowledge.userCommands.has(command) ? 50 : undefined,
      },
      knowledge.userCommands.has(command) ? "Macro" : "LaTeX",
    ),
  );

  return {
    from: word.from,
    options,
    validFor: /^\\[A-Za-z@]*$/u,
  };
};

/** TeX knowledge state shared by Markdown, LaTeX and Pandoc-YAML editors. */
export function texKnowledgeExtensions(kind: TexDocumentKind): Extension[] {
  return [texDocumentKind.of(kind), texVocabularyField];
}

/** Standalone completion UI for non-Markdown editors. */
export const texCommandAutocomplete = autocompletion({
  activateOnTyping: true,
  selectOnOpen: true,
  closeOnBlur: true,
  maxRenderedOptions: 20,
  override: [texCommandCompletionSource],
  defaultKeymap: false,
});
