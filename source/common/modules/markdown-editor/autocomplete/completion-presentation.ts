import { type Completion } from '@codemirror/autocomplete'

interface PresentedCompletion extends Completion {
  zettlrCompletionSource?: string
}

const SOURCE_ICONS: Readonly<Record<string, string>> = {
  Citation: '@',
  Dictionary: 'D',
  LaTeX: 'T',
  Macro: 'M',
  Pandoc: 'P',
  Snippet: 'S'
}

const TYPE_ICONS: Readonly<Record<string, string>> = {
  class: '○',
  constant: 'C',
  enum: '∪',
  function: 'ƒ',
  interface: '◌',
  keyword: 'k',
  method: 'ƒ',
  namespace: '▢',
  property: '□',
  text: 'abc',
  type: 't',
  variable: 'x'
}

/**
 * Adds presentation-only provenance to a native CodeMirror completion.
 *
 * Matching, ranking, insertion and the provider's own detail/info values are
 * deliberately untouched. The metadata is consumed only by the shared menu
 * renderer below.
 */
export function withCompletionSource<T extends Completion> (
  completion: T,
  source: string
): T & PresentedCompletion {
  return { ...completion, zettlrCompletionSource: source }
}

export function completionSource (completion: Completion): string|undefined {
  return (completion as PresentedCompletion).zettlrCompletionSource
}

export function completionIconText (completion: Completion): string {
  const source = completionSource(completion)
  if (source !== undefined && SOURCE_ICONS[source] !== undefined) {
    return SOURCE_ICONS[source]
  }

  for (const type of completion.type?.split(/\s+/u) ?? []) {
    if (TYPE_ICONS[type] !== undefined) {
      return TYPE_ICONS[type]
    }
  }
  return ''
}

/**
 * Native CodeMirror option columns. Position 20 replaces its built-in semantic
 * icon with a source icon where provenance is known; position 70 inserts a
 * dedicated, fixed column before CodeMirror's ordinary detail (position 80).
 */
export const completionPresentationOptions = [
  {
    position: 20,
    render (completion: Completion): Node {
      const icon = document.createElement('span')
      icon.className = 'cm-completionIcon cm-completionSourceIcon'
      icon.textContent = completionIconText(completion)
      icon.setAttribute('aria-hidden', 'true')
      return icon
    }
  },
  {
    position: 70,
    render (completion: Completion): Node {
      const source = document.createElement('span')
      source.className = 'cm-completionSource'
      const label = completionSource(completion)
      source.textContent = label === undefined ? '' : `[${label}]`
      if (label === undefined) {
        source.setAttribute('aria-hidden', 'true')
      }
      return source
    }
  }
] as const
