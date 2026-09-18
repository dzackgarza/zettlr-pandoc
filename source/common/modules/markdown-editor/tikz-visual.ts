/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Source-faithful tikzpicture visual-edit model
 * CVM-Role:        Domain
 * License:         GNU GPL v3
 *
 * Description:     Projects the mature @tikz-editor Lezer grammar into the
 *                  deliberately editable subset used by Zettlr's visual
 *                  tikzpicture provider. The model never regenerates a whole
 *                  picture. Every edit either replaces one parser-owned source
 *                  span or inserts one new statement before \end{tikzpicture},
 *                  so comments, style declarations and unsupported TikZ remain
 *                  byte-for-byte source authority.
 *
 * END HEADER
 */

import type { SyntaxNode } from '@lezer/common'
import { tikzLanguage } from './parser/tikz-parser'
import type { TikzLivePreviewTarget } from './tikz-live-preview'
import { rawTikzEnvironment } from './tikz-block'

export interface SourceSpan {
  from: number
  to: number
}

export type TikzVisualShape = 'rectangle'|'circle'|'plain'

export interface TikzVisualStyle {
  name: string
  shape: TikzVisualShape
  draw: boolean
  minimumWidthCm: number|null
  minimumHeightCm: number|null
  minimumSizeCm: number|null
}

export interface TikzVisualNode {
  id: string
  name: string
  x: number
  y: number
  label: string
  options: string
  styleName: string|null
  shape: TikzVisualShape
  draw: boolean
  widthCm: number
  heightCm: number
  statementSpan: SourceSpan
  nameSpan: SourceSpan
  coordinateSpan: SourceSpan
  labelSpan: SourceSpan
}

export type TikzNodeAnchor = 'center'|'north'|'south'|'east'|'west'

export interface TikzVisualEndpoint {
  node: string
  anchor: TikzNodeAnchor
  span: SourceSpan
}

export interface TikzVisualArrow {
  id: string
  options: string
  from: TikzVisualEndpoint
  to: TikzVisualEndpoint
  statementSpan: SourceSpan
  forwardArrow: boolean
  backwardArrow: boolean
}

export interface TikzVisualScene {
  source: string
  nodes: TikzVisualNode[]
  arrows: TikzVisualArrow[]
  styles: TikzVisualStyle[]
  insertAt: number
  warnings: string[]
}

export interface TikzVisualSourceSession {
  kind: 'raw'|'fence'
  blockFrom: number
  blockTo: number
  sourceFrom: number
  sourceTo: number
  source: string
}

const DEFAULT_RECTANGLE_WIDTH_CM = 2
const DEFAULT_RECTANGLE_HEIGHT_CM = 0.8
const DEFAULT_CIRCLE_SIZE_CM = 0.8

function descendants (node: SyntaxNode, name: string): SyntaxNode[] {
  const matches: SyntaxNode[] = []
  const cursor = node.cursor()
  if (!cursor.firstChild()) return matches
  do {
    const child = cursor.node
    if (child.name === name) matches.push(child)
    matches.push(...descendants(child, name))
  } while (cursor.nextSibling())
  return matches
}

function hasDescendant (node: SyntaxNode, name: string): boolean {
  return descendants(node, name).length > 0
}

function stripDelimited (source: string, node: SyntaxNode, open: string, close: string): string|null {
  const text = source.slice(node.from, node.to)
  if (!text.startsWith(open) || !text.endsWith(close)) return null
  return text.slice(open.length, text.length - close.length)
}

function splitTopLevel (source: string): string[] {
  const parts: string[] = []
  let start = 0
  let braces = 0
  let brackets = 0
  let parens = 0
  let escaped = false

  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '%') {
      const newline = source.indexOf('\n', i + 1)
      if (newline === -1) break
      i = newline
      continue
    }
    switch (char) {
      case '{': braces++; break
      case '}': braces = Math.max(0, braces - 1); break
      case '[': brackets++; break
      case ']': brackets = Math.max(0, brackets - 1); break
      case '(': parens++; break
      case ')': parens = Math.max(0, parens - 1); break
      case ',':
        if (braces === 0 && brackets === 0 && parens === 0) {
          parts.push(source.slice(start, i).trim())
          start = i + 1
        }
        break
    }
  }
  parts.push(source.slice(start).trim())
  return parts.filter(part => part !== '')
}

function parseLengthCm (value: string): number|null {
  const match = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(cm|mm|pt|in)?\s*$/u.exec(value)
  if (match === null) return null
  const amount = Number.parseFloat(match[1])
  if (!Number.isFinite(amount)) return null
  switch (match[2] ?? 'cm') {
    case 'cm': return amount
    case 'mm': return amount / 10
    case 'pt': return amount / 28.4527559055
    case 'in': return amount * 2.54
    default: return null
  }
}

function styleFromOptions (name: string, options: string): TikzVisualStyle {
  const parts = splitTopLevel(options)
  let shape: TikzVisualShape = 'plain'
  let draw = false
  let minimumWidthCm: number|null = null
  let minimumHeightCm: number|null = null
  let minimumSizeCm: number|null = null

  for (const part of parts) {
    const normalized = part.trim()
    if (normalized === 'rectangle') shape = 'rectangle'
    if (normalized === 'circle') shape = 'circle'
    if (normalized === 'draw' || normalized.startsWith('draw=')) draw = true
    const assignment = /^([^=]+?)\s*=\s*(.+)$/su.exec(normalized)
    if (assignment === null) continue
    const key = assignment[1].trim().replace(/\s+/gu, ' ')
    const value = parseLengthCm(assignment[2])
    if (value === null) continue
    if (key === 'minimum width') minimumWidthCm = value
    if (key === 'minimum height') minimumHeightCm = value
    if (key === 'minimum size') minimumSizeCm = value
  }

  return { name, shape, draw, minimumWidthCm, minimumHeightCm, minimumSizeCm }
}

function parseStyles (source: string, environment: SyntaxNode): TikzVisualStyle[] {
  const optionList = descendants(environment, 'OptionList')
    .find(node => node.parent?.name === 'TikzEnvironment')
  if (optionList === undefined) return []
  const contents = stripDelimited(source, optionList, '[', ']')
  if (contents === null) return []

  const styles: TikzVisualStyle[] = []
  for (const part of splitTopLevel(contents)) {
    const declaration = /^\s*([^=,/\s]+)\s*\/\.style\s*=\s*\{([\s\S]*)\}\s*$/u.exec(part)
    if (declaration === null) continue
    styles.push(styleFromOptions(declaration[1], declaration[2]))
  }
  return styles
}

function parseLiteralCoordinate (value: string): { x: number, y: number }|null {
  const match = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*,\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*$/u.exec(value)
  if (match === null) return null
  const x = Number.parseFloat(match[1])
  const y = Number.parseFloat(match[2])
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

function parseNodeName (value: string): string|null {
  const normalized = value.trim()
  return /^[A-Za-z@][A-Za-z0-9_:@.-]*$/u.test(normalized) ? normalized : null
}

function optionsForStatement (source: string, statement: SyntaxNode, before: number): { source: string, node: SyntaxNode }|null {
  const option = descendants(statement, 'OptionList')
    .filter(node => node.from < before)
    .sort((a, b) => a.from - b.from)[0]
  if (option === undefined) return null
  const contents = stripDelimited(source, option, '[', ']')
  return contents === null ? null : { source: contents, node: option }
}

function resolveNodeStyle (
  options: string,
  styles: readonly TikzVisualStyle[]
): TikzVisualStyle {
  const optionParts = splitTopLevel(options)
  for (const part of optionParts) {
    const style = styles.find(candidate => candidate.name === part.trim())
    if (style !== undefined) return style
  }
  return styleFromOptions('', options)
}

function dimensionsForNode (style: TikzVisualStyle, label: string): { width: number, height: number } {
  if (style.shape === 'circle') {
    const size = Math.max(style.minimumSizeCm ?? DEFAULT_CIRCLE_SIZE_CM, 0.8)
    return { width: size, height: size }
  }
  const contentEstimate = Math.max(0.8, label.replace(/\\[A-Za-z@]+/gu, 'x').length * 0.115)
  const defaultWidth = style.shape === 'rectangle' ? DEFAULT_RECTANGLE_WIDTH_CM : 0.8
  const defaultHeight = style.shape === 'rectangle' ? DEFAULT_RECTANGLE_HEIGHT_CM : 0.55
  return {
    width: Math.max(style.minimumSizeCm ?? 0, style.minimumWidthCm ?? defaultWidth, contentEstimate),
    height: Math.max(style.minimumSizeCm ?? 0, style.minimumHeightCm ?? defaultHeight)
  }
}

function parseVisualNode (
  source: string,
  statement: SyntaxNode,
  styles: readonly TikzVisualStyle[],
  index: number
): TikzVisualNode|null {
  if (!hasDescendant(statement, 'NodeCmd')) return null

  const coordinates = descendants(statement, 'Coordinate').sort((a, b) => a.from - b.from)
  let nameNode: SyntaxNode|undefined
  let name: string|null = null
  let positionNode: SyntaxNode|undefined
  let position: { x: number, y: number }|null = null

  for (const coordinate of coordinates) {
    const contents = stripDelimited(source, coordinate, '(', ')')
    if (contents === null) continue
    if (nameNode === undefined) {
      const candidate = parseNodeName(contents)
      if (candidate !== null) {
        nameNode = coordinate
        name = candidate
        continue
      }
    }
    if (nameNode !== undefined && positionNode === undefined) {
      const candidate = parseLiteralCoordinate(contents)
      if (candidate !== null) {
        positionNode = coordinate
        position = candidate
        break
      }
    }
  }

  const labelNode = descendants(statement, 'NodeTextGroup').sort((a, b) => a.from - b.from)[0]
  if (
    nameNode === undefined || name === null ||
    positionNode === undefined || position === null ||
    labelNode === undefined
  ) {
    return null
  }

  const label = stripDelimited(source, labelNode, '{', '}')
  if (label === null) return null
  const options = optionsForStatement(source, statement, nameNode.from)?.source ?? ''
  const visualStyle = resolveNodeStyle(options, styles)
  const dimensions = dimensionsForNode(visualStyle, label)

  return {
    id: `node:${name}:${statement.from}:${index}`,
    name,
    x: position.x,
    y: position.y,
    label,
    options,
    styleName: splitTopLevel(options).find(part => styles.some(style => style.name === part.trim()))?.trim() ?? null,
    shape: visualStyle.shape,
    draw: visualStyle.draw,
    widthCm: dimensions.width,
    heightCm: dimensions.height,
    statementSpan: { from: statement.from, to: statement.to },
    nameSpan: { from: nameNode.from + 1, to: nameNode.to - 1 },
    coordinateSpan: { from: positionNode.from, to: positionNode.to },
    labelSpan: { from: labelNode.from + 1, to: labelNode.to - 1 }
  }
}

function normalizeAnchor (value: string|undefined): TikzNodeAnchor|null {
  switch ((value ?? 'center').trim()) {
    case 'center': return 'center'
    case 'north': return 'north'
    case 'south': return 'south'
    case 'east': return 'east'
    case 'west': return 'west'
    default: return null
  }
}

function parseEndpoint (source: string, coordinate: SyntaxNode): TikzVisualEndpoint|null {
  const contents = stripDelimited(source, coordinate, '(', ')')
  if (contents === null) return null
  const match = /^\s*([A-Za-z@][A-Za-z0-9_:@.-]*?)(?:\.([A-Za-z]+))?\s*$/u.exec(contents)
  if (match === null) return null
  const anchor = normalizeAnchor(match[2])
  if (anchor === null) return null
  const nameOffset = contents.indexOf(match[1])
  return {
    node: match[1],
    anchor,
    span: {
      from: coordinate.from + 1 + nameOffset,
      to: coordinate.from + 1 + nameOffset + match[1].length
    }
  }
}

function parseVisualArrow (source: string, statement: SyntaxNode, index: number): TikzVisualArrow|null {
  if (!hasDescendant(statement, 'DrawCmd')) return null
  const operators = descendants(statement, 'PathOperator')
  if (operators.length !== 1 || source.slice(operators[0].from, operators[0].to) !== '--') return null
  const coordinates = descendants(statement, 'Coordinate')
    .sort((a, b) => a.from - b.from)
    .map(node => parseEndpoint(source, node))
    .filter((endpoint): endpoint is TikzVisualEndpoint => endpoint !== null)
  if (coordinates.length !== 2) return null

  const options = optionsForStatement(source, statement, coordinates[0].span.from)?.source ?? ''
  const compactOptions = options.replace(/\s+/gu, '')
  return {
    id: `arrow:${statement.from}:${index}`,
    options,
    from: coordinates[0],
    to: coordinates[1],
    statementSpan: { from: statement.from, to: statement.to },
    forwardArrow: compactOptions.includes('->') || compactOptions.includes('<->'),
    backwardArrow: compactOptions.includes('<-') || compactOptions.includes('<->')
  }
}

function lineStartBefore (source: string, position: number): number {
  const newline = source.lastIndexOf('\n', Math.max(0, position - 1))
  const start = newline === -1 ? 0 : newline + 1
  return source.slice(start, position).trim() === '' ? start : position
}

export function parseTikzVisualScene (source: string): TikzVisualScene {
  if (rawTikzEnvironment(source) !== 'tikzpicture') {
    throw new Error('Visual TikZ editing requires one complete tikzpicture environment.')
  }

  const tree = tikzLanguage.parser.parse(source)
  const environment = tree.topNode.getChild('TikzEnvironment')
  if (environment === null) {
    throw new Error('The TikZ grammar did not produce a tikzpicture environment.')
  }
  const end = environment.getChild('EndTikz')
  if (end === null) {
    throw new Error('The tikzpicture environment has no parsed closing delimiter.')
  }

  const styles = parseStyles(source, environment)
  const statements: SyntaxNode[] = []
  environment.toTree().iterate({
    enter: node => {
      if (node.name === 'PathStatement') statements.push(node.node)
    }
  })

  const nodes: TikzVisualNode[] = []
  const arrows: TikzVisualArrow[] = []
  const warnings: string[] = []
  statements.forEach((statement, index) => {
    const text = source.slice(statement.from, statement.to).trimStart()
    if (hasDescendant(statement, 'NodeCmd')) {
      const node = parseVisualNode(source, statement, styles, index)
      if (node === null) {
        warnings.push(`A node at source offset ${statement.from} uses placement syntax the visual editor leaves source-only.`)
      } else {
        nodes.push(node)
      }
      return
    }
    if (hasDescendant(statement, 'DrawCmd') && text.startsWith('\\draw')) {
      const arrow = parseVisualArrow(source, statement, index)
      if (arrow === null) {
        warnings.push(`A draw path at source offset ${statement.from} is outside the visual editor's straight named-node subset.`)
      } else {
        arrows.push(arrow)
      }
    }
  })

  return {
    source,
    nodes,
    arrows,
    styles,
    insertAt: lineStartBefore(source, end.from),
    warnings
  }
}

function replaceSpan (source: string, span: SourceSpan, insert: string): string {
  return source.slice(0, span.from) + insert + source.slice(span.to)
}

function formatCoordinateNumber (value: number): string {
  if (!Number.isFinite(value)) throw new Error('TikZ coordinates must be finite numbers.')
  const rounded = Math.round(value * 1000) / 1000
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

export function moveTikzVisualNode (
  scene: TikzVisualScene,
  nodeId: string,
  x: number,
  y: number
): string {
  const node = scene.nodes.find(candidate => candidate.id === nodeId)
  if (node === undefined) throw new Error(`Unknown visual TikZ node: ${nodeId}`)
  return replaceSpan(
    scene.source,
    node.coordinateSpan,
    `(${formatCoordinateNumber(x)},${formatCoordinateNumber(y)})`
  )
}

export function editTikzVisualNodeLabel (
  scene: TikzVisualScene,
  nodeId: string,
  label: string
): string {
  const node = scene.nodes.find(candidate => candidate.id === nodeId)
  if (node === undefined) throw new Error(`Unknown visual TikZ node: ${nodeId}`)
  return replaceSpan(scene.source, node.labelSpan, label)
}

export function nextTikzVisualNodeName (scene: TikzVisualScene, prefix = 'node'): string {
  const names = new Set(scene.nodes.map(node => node.name))
  let index = 1
  while (names.has(`${prefix}${index}`)) index++
  return `${prefix}${index}`
}

export function isValidTikzVisualNodeName (name: string): boolean {
  return /^[A-Za-z@][A-Za-z0-9_:@.-]*$/u.test(name)
}

function insertionForStatement (scene: TikzVisualScene, statement: string): string {
  const before = scene.source.slice(0, scene.insertAt)
  const prefix = before === '' || before.endsWith('\n') ? '' : '\n'
  return `${prefix}${statement}\n`
}

export function addTikzVisualNode (
  scene: TikzVisualScene,
  input: {
    shape: Exclude<TikzVisualShape, 'plain'>
    name: string
    label: string
    x: number
    y: number
  }
): string {
  if (!isValidTikzVisualNodeName(input.name)) {
    throw new Error('TikZ node names must start with a letter or @ and contain only letters, numbers, _, :, @, . or -.')
  }
  if (scene.nodes.some(node => node.name === input.name)) {
    throw new Error(`TikZ node name "${input.name}" already exists.`)
  }
  const style = scene.styles.find(candidate => candidate.shape === input.shape)
  const options = style?.name ?? (
    input.shape === 'circle'
      ? 'circle, draw, minimum size=0.8cm'
      : 'rectangle, draw, minimum width=3cm, minimum height=0.8cm'
  )
  const statement = `\\node[${options}] (${input.name}) at (${formatCoordinateNumber(input.x)},${formatCoordinateNumber(input.y)}) {${input.label}};`
  return scene.source.slice(0, scene.insertAt) +
    insertionForStatement(scene, statement) +
    scene.source.slice(scene.insertAt)
}

function anchorsForVector (dx: number, dy: number): { from: TikzNodeAnchor, to: TikzNodeAnchor } {
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { from: 'east', to: 'west' } : { from: 'west', to: 'east' }
  }
  return dy >= 0 ? { from: 'north', to: 'south' } : { from: 'south', to: 'north' }
}

export function addTikzVisualArrow (
  scene: TikzVisualScene,
  fromNodeId: string,
  toNodeId: string
): string {
  const from = scene.nodes.find(node => node.id === fromNodeId)
  const to = scene.nodes.find(node => node.id === toNodeId)
  if (from === undefined || to === undefined) {
    throw new Error('Both arrow endpoints must be editable visual TikZ nodes.')
  }
  if (from.id === to.id) {
    throw new Error('The straight-arrow tool requires two distinct nodes.')
  }
  const anchors = anchorsForVector(to.x - from.x, to.y - from.y)
  const statement = `\\draw[->] (${from.name}.${anchors.from}) -- (${to.name}.${anchors.to});`
  return scene.source.slice(0, scene.insertAt) +
    insertionForStatement(scene, statement) +
    scene.source.slice(scene.insertAt)
}

export function deleteTikzVisualArrow (scene: TikzVisualScene, arrowId: string): string {
  const arrow = scene.arrows.find(candidate => candidate.id === arrowId)
  if (arrow === undefined) throw new Error(`Unknown visual TikZ arrow: ${arrowId}`)
  const rawLineStart = scene.source.lastIndexOf('\n', Math.max(0, arrow.statementSpan.from - 1)) + 1
  const rawLineEnd = scene.source.indexOf('\n', arrow.statementSpan.to)
  const lineEnd = rawLineEnd === -1 ? scene.source.length : rawLineEnd
  const ownsWholeLine =
    scene.source.slice(rawLineStart, arrow.statementSpan.from).trim() === '' &&
    scene.source.slice(arrow.statementSpan.to, lineEnd).trim() === ''
  const from = ownsWholeLine ? rawLineStart : arrow.statementSpan.from
  const to = ownsWholeLine && rawLineEnd !== -1 ? rawLineEnd + 1 : arrow.statementSpan.to
  return scene.source.slice(0, from) + scene.source.slice(to)
}

export function visualSessionForBlock (target: TikzLivePreviewTarget): TikzVisualSourceSession {
  if (target.language !== 'tikz' || rawTikzEnvironment(target.source) !== 'tikzpicture') {
    throw new Error('Visual TikZ sessions require a complete tikzpicture source block.')
  }
  return {
    kind: target.kind,
    blockFrom: target.from,
    blockTo: target.to,
    sourceFrom: target.sourceFrom,
    sourceTo: target.sourceTo,
    source: target.source
  }
}

export function replaceVisualSessionSource (
  session: TikzVisualSourceSession,
  insert: string
): { from: number, to: number, insert: string, next: TikzVisualSourceSession } {
  const delta = insert.length - session.source.length
  return {
    from: session.sourceFrom,
    to: session.sourceTo,
    insert,
    next: {
      ...session,
      blockTo: session.blockTo + delta,
      sourceTo: session.sourceTo + delta,
      source: insert
    }
  }
}
