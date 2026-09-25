declare module 'monaco-editor-core/esm/vs/editor/contrib/snippet/browser/snippetParser.js' {
  export abstract class Marker {
    readonly children: Marker[]
    parent: Marker | undefined
    appendChild (child: Marker): this
    replace (child: Marker, others: Marker[]): void
    toString (): string
    len (): number
    clone (): Marker
  }

  export class Text extends Marker {
    constructor (value: string)
    value: string
  }

  export class Choice extends Marker {
    readonly options: Text[]
  }

  export class Transform {
    resolve (value: string): string
  }

  export class Placeholder extends Marker {
    constructor (index: number)
    index: number
    readonly isFinalTabstop: boolean
    readonly choice: Choice | undefined
    transform: Transform | undefined
  }

  export class Variable extends Marker {
    name: string
    transform: Transform | undefined
    resolve (resolver: VariableResolver): boolean
  }

  export interface VariableResolver {
    resolve (variable: Variable): string | undefined
  }

  export class TextmateSnippet extends Marker {
    readonly placeholders: Placeholder[]
    readonly placeholderInfo: { all: Placeholder[], last: Placeholder | undefined }
    offset (marker: Marker): number
    fullLen (marker: Marker): number
    enclosingPlaceholders (placeholder: Placeholder): Placeholder[]
    resolveVariables (resolver: VariableResolver): this
    walk (visitor: (marker: Marker) => boolean): void
  }

  export class SnippetParser {
    static guessNeedsClipboard (template: string): boolean
    parse (
      value: string,
      insertFinalTabstop?: boolean,
      enforceFinalTabstop?: boolean
    ): TextmateSnippet
  }
}
