/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikzRenderer
 * CVM-Role:        View
 * License:         GNU GPL v3
 *
 * Description:     Renders TikZ figures inline (issue #14): raw
 *                  \begin{tikzcd}/\begin{tikzpicture} blocks and ```tikz
 *                  code fences become async figure widgets. Compilation
 *                  happens in the main process (pdflatex + pdf2svg behind
 *                  the vendored pandoc filter's content-addressed cache),
 *                  so rendering never blocks typing; a cache hit lands
 *                  immediately. A figure that fails to compile shows the
 *                  filter's LaTeX bang-error diagnostic mapped to the tikz
 *                  source line; a machine without the toolchain names the
 *                  missing tools. Clicking a rendered figure requests the
 *                  full-screen lightbox with the servable SVG file.
 *
 * END HEADER
 */

import { renderBlockWidgets } from './base-renderer'
import { type SyntaxNode, type SyntaxNodeRef } from '@lezer/common'
import { WidgetType, EditorView } from '@codemirror/view'
import { type EditorState } from '@codemirror/state'
import { configField } from '../util/configuration'
import type { TikzRenderRequest, TikzRenderResult } from 'source/app/util/tikz-render'

const RAW_OPEN_RE = /^\\begin\{(tikzcd|tikzpicture)\}/

/**
 * One in-flight/settled render per figure source. The main process holds the
 * durable content-addressed cache; this memo only prevents a redraw from
 * re-crossing the IPC boundary for a figure already rendered this session.
 */
let renderMemo = new Map<string, Promise<TikzRenderResult>>()

/** Test seam: clears the session memo so seam stubs see every request. */
export function __resetTikzRenderMemoForTests (): void {
  renderMemo = new Map()
}

function requestRender (request: TikzRenderRequest): Promise<TikzRenderResult> {
  const key = `${request.kind}\0${request.source}`
  const memoized = renderMemo.get(key)
  if (memoized !== undefined) {
    return memoized
  }
  const pending: Promise<TikzRenderResult> = window.ipc.invoke('application', {
    command: 'tikz-render',
    payload: request,
  })
  renderMemo.set(key, pending)
  return pending
}

function populate (elem: HTMLElement, result: TikzRenderResult): void {
  elem.classList.remove('tikz-pending')
  if (result.ok) {
    // The filter wraps the figure as Para(RawInline(html)); the HTML writer's
    // <p> around a <div> gets split by the browser into a stray empty
    // paragraph with margins. Mount only the element that hosts the SVG.
    const template = document.createElement('template')
    template.innerHTML = result.html
    const svgHost = template.content.querySelector('svg')?.closest('div') ?? null
    if (svgHost !== null) {
      elem.replaceChildren(svgHost)
    } else {
      elem.innerHTML = result.html
    }
    elem.dataset.tikzSvgPath = result.svgPath
    return
  }

  const box = document.createElement('div')
  box.classList.add('tikz-error')
  const title = document.createElement('strong')
  box.appendChild(title)

  if (result.kind === 'missing-tools') {
    title.textContent = `TikZ rendering requires tools that were not found: ${result.missing.join(', ')}`
  } else if (result.kind === 'compile-error') {
    title.textContent = 'TikZ figure failed to compile'
    for (const error of result.errors) {
      const line = document.createElement('div')
      const where = document.createElement('span')
      where.textContent = `line ${error.line}: ${error.message} `
      const source = document.createElement('code')
      source.textContent = error.sourceLine
      line.appendChild(where)
      line.appendChild(source)
      box.appendChild(line)
    }
    if (result.errors.length === 0) {
      const note = document.createElement('div')
      note.textContent = 'The figure produced no diagnostic; see the render log.'
      box.appendChild(note)
    }
  } else {
    title.textContent = 'TikZ render failed (pandoc error)'
    const log = document.createElement('pre')
    log.textContent = result.log.split('\n').slice(-8).join('\n')
    box.appendChild(log)
  }

  elem.replaceChildren(box)
}

class TikzWidget extends WidgetType {
  constructor (readonly source: string, readonly kind: 'raw'|'fence', readonly node: SyntaxNode) {
    super()
  }

  eq (other: TikzWidget): boolean {
    return other.source === this.source && other.kind === this.kind
  }

  toDOM (view: EditorView): HTMLElement {
    const elem = document.createElement('div')
    elem.classList.add('tikz-figure', 'tikz-pending')
    elem.textContent = 'Rendering TikZ figure…'

    const docPath = view.state.field(configField, false)?.metadata.path
    requestRender({ source: this.source, kind: this.kind, docPath })
      .then(result => { populate(elem, result) })
      .catch(err => {
        populate(elem, { ok: false, kind: 'pandoc-error', log: err instanceof Error ? err.message : String(err) })
      })

    elem.addEventListener('click', () => {
      const svgPath = elem.dataset.tikzSvgPath
      if (svgPath !== undefined) {
        // Construct the event through the element's own window so the
        // dispatch works identically in the app and under jsdom.
        const EventCtor = elem.ownerDocument.defaultView?.CustomEvent ?? CustomEvent
        elem.ownerDocument.dispatchEvent(new EventCtor('zettlr-tikz-lightbox', { detail: { svgPath } }))
      }
    })
    return elem
  }

  updateDOM (_dom: HTMLElement, _view: EditorView): boolean {
    return false // Source changed: rebuild and re-render.
  }

  ignoreEvent (_event: Event): boolean {
    return true // The widget owns its events (click opens the lightbox).
  }
}

function shouldHandleNode (node: SyntaxNodeRef): boolean {
  return node.type.name === 'Paragraph' || node.type.name === 'FencedCode'
}

function createWidget (state: EditorState, node: SyntaxNodeRef): TikzWidget|undefined {
  if (node.type.name === 'Paragraph') {
    const text = state.sliceDoc(node.from, node.to)
    const open = RAW_OPEN_RE.exec(text)
    if (open === null || !text.trimEnd().endsWith(`\\end{${open[1]}}`)) {
      return undefined
    }
    return new TikzWidget(text, 'raw', node.node)
  }

  // FencedCode: only ```tikz / ```{.tikz …} fences are figures.
  const info = node.node.getChild('CodeInfo')
  if (info === null) {
    return undefined
  }
  const infoText = state.sliceDoc(info.from, info.to).trim()
  const isTikz = infoText === 'tikz' || /^\{[^}]*\.tikz[\s}]/.test(infoText)
  if (!isTikz) {
    return undefined
  }
  const body = node.node.getChild('CodeText')
  if (body === null) {
    return undefined
  }
  return new TikzWidget(state.sliceDoc(body.from, body.to), 'fence', node.node)
}

export const renderTikzFigures = [
  renderBlockWidgets(shouldHandleNode, createWidget),
  EditorView.baseTheme({
    '.tikz-figure': {
      display: 'block',
      textAlign: 'center',
      padding: '0.4em 0',
      cursor: 'zoom-in',
    },
    '.tikz-figure svg': {
      maxWidth: '100%',
      height: 'auto',
    },
    // pdflatex output is black-on-transparent; invert it for dark themes
    // (the TikZ analog of mermaid's dark-theme reinitialization).
    '&dark .tikz-figure svg': {
      filter: 'invert(0.85) hue-rotate(180deg)',
    },
    '.tikz-pending': {
      opacity: '0.6',
      fontStyle: 'italic',
    },
    '.tikz-error': {
      display: 'inline-block',
      textAlign: 'left',
      border: '1px solid #c0392b',
      borderRadius: '4px',
      padding: '0.4em 0.8em',
      color: '#c0392b',
      cursor: 'text',
    },
  }),
]
