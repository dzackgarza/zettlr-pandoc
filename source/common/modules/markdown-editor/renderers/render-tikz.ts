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
 *                  missing tools; a toolchain check that failed for a reason
 *                  other than absence names the tool and the errno instead of
 *                  telling the user to install it; a render killed by a signal
 *                  names the signal. Clicking a rendered figure requests the
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

/**
 * Turns the render service's figure markup into the nodes to mount.
 *
 * The filter emits the figure as Para(RawInline(html)), so pandoc's HTML
 * writer wraps it in a <p>; the browser splits <p><div> and leaves a stray
 * empty paragraph whose margins push the figure around. Unwrapping every
 * paragraph into its own children removes that wrapper for good: the
 * transformation is total, so there is no "could not find the figure" case for
 * the mount to fall back from.
 */
function figureNodes (html: string): Node[] {
  const template = document.createElement('template')
  template.innerHTML = html

  // An ok result is only issued after the service confirmed the pandoc output
  // carries an <svg>…</svg>; markup without one means service and widget
  // disagree about what a successful render is, which no presentation can
  // repair.
  if (template.content.querySelector('svg') === null) {
    throw new Error(
      'render-tikz: the render service reported a successful figure whose markup carries no <svg> element. ' +
      `Markup received (${html.length} chars): ${html.slice(0, 200)}. ` +
      'renderTikz in source/app/util/tikz-render.ts only returns ok after matching <svg>…</svg> in the ' +
      'pandoc output, so either that check or this widget must change.'
    )
  }

  const nodes: Node[] = []
  for (const child of Array.from(template.content.childNodes)) {
    if (child instanceof HTMLParagraphElement) {
      nodes.push(...Array.from(child.childNodes))
    } else {
      nodes.push(child)
    }
  }
  return nodes
}

function populate (elem: HTMLElement, result: TikzRenderResult): void {
  if (result.ok) {
    const figure = figureNodes(result.html)
    elem.classList.remove('tikz-pending')
    elem.replaceChildren(...figure)
    elem.dataset.tikzSvgPath = result.svgPath
    return
  }

  elem.classList.remove('tikz-pending')
  const box = document.createElement('div')
  box.classList.add('tikz-error')
  const title = document.createElement('strong')
  box.appendChild(title)

  switch (result.kind) {
    case 'missing-tools':
      title.textContent = `TikZ rendering requires tools that were not found: ${result.missing.join(', ')}`
      break
    case 'toolchain-probe-failed':
      // Deliberately not "install this tool": the tool may well be installed.
      // The errno is the whole diagnosis — EACCES is a permission bit, EAGAIN
      // is resource exhaustion — and telling the user to install something
      // instead would send them after the wrong problem.
      title.textContent = `TikZ could not check whether ${result.tool} is usable: the check failed with ${result.code}`
      break
    case 'compile-error': {
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
      break
    }
    case 'pandoc-error': {
      title.textContent = 'TikZ render failed (pandoc error)'
      const log = document.createElement('pre')
      log.textContent = result.log.split('\n').slice(-8).join('\n')
      box.appendChild(log)
      break
    }
    case 'render-terminated': {
      // Naming the signal is the point: a killed render is not pandoc
      // reporting anything about the figure, and the user needs to know the
      // difference to act on it.
      title.textContent = `TikZ render was killed by ${result.signal} before it finished`
      const log = document.createElement('pre')
      log.textContent = result.log.split('\n').slice(-8).join('\n')
      box.appendChild(log)
      break
    }
    default: {
      const unhandled: never = result
      throw new Error(
        `render-tikz: unhandled TikzRenderResult case ${JSON.stringify(unhandled)}. ` +
        'The union lives in source/app/util/tikz-render.ts; every case it declares must be presented here.'
      )
    }
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

    // The configuration carries the buffer's path, using the empty string for
    // a buffer that has none — the same value the request field is declared
    // against. This renderer is only ever installed alongside configField, so
    // its absence is a wiring defect and reads as one.
    const docPath = view.state.field(configField).metadata.path
    requestRender({ source: this.source, kind: this.kind, docPath })
      .then(
        result => { populate(elem, result) },
        // Only the IPC round-trip is handled here. A failure to reach the main
        // process is a render failure the user must see; a failure raised by
        // populate is a broken service/widget contract and must not be dressed
        // up as one of the render service's outcomes.
        (err: unknown) => {
          populate(elem, { ok: false, kind: 'pandoc-error', log: err instanceof Error ? err.message : String(err) })
        }
      )

    elem.addEventListener('click', () => {
      const svgPath = elem.dataset.tikzSvgPath
      if (svgPath === undefined) {
        // A figure that is still pending, or that failed, has no servable SVG
        // and therefore nothing to open. This is a real state of the widget,
        // not a missing value.
        return
      }

      // An event is only accepted by the document it is dispatched on if it
      // was built by that document's own realm, so the constructor comes from
      // the clicked element's window. A widget element that is handling a
      // click is in a rendered document, so that window exists; if it does
      // not, the widget is somewhere it was never mounted and the request has
      // no host to reach.
      const ownerWindow = elem.ownerDocument.defaultView
      if (ownerWindow === null) {
        throw new Error(
          'render-tikz: a rendered TikZ figure was clicked while its element sat in a document with ' +
          `no window (svgPath=${svgPath}, isConnected=${String(elem.isConnected)}). The lightbox ` +
          'request is constructed through the element\'s own window because a CustomEvent built in a ' +
          'different realm is rejected by the document it is dispatched on; a windowless document ' +
          'offers neither that realm nor a TikzLightbox listening for the request.'
        )
      }
      elem.ownerDocument.dispatchEvent(new ownerWindow.CustomEvent('zettlr-tikz-lightbox', { detail: { svgPath } }))
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
