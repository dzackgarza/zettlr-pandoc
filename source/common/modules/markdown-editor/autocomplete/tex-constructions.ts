/**
 * High-level LaTeX/TikZ construction snippets.
 *
 * Command names and environments remain owned by maintained external/catalogue
 * sources. This file supplies the small ergonomic layer editors such as
 * Overleaf expose: short mnemonic triggers that insert an entire common
 * construction with navigable fields.
 */
import {
  snippet as codeMirrorSnippet,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete'
import { isMathPosition } from '../util/is-math-position'
import { tikzBlockAt } from '../tikz-block'
import {
  completionInfoPanel,
  type CompletionSourceName,
} from './completion-presentation'

interface Construction {
  triggers: string[]
  body: string
  description: string
  source: CompletionSourceName
  context: 'math'|'tikz'|'tikzcd'
}

const CONSTRUCTIONS: Construction[] = [
  {
    triggers: ['frac'],
    body: '\\frac{${1:numerator}}{${2:denominator}}$0',
    description: 'Fraction with numerator and denominator fields.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['sqrt'],
    body: '\\sqrt{${1:radicand}}$0',
    description: 'Square root; edit the radicand first.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['binom'],
    body: '\\binom{${1:n}}{${2:k}}$0',
    description: 'Binomial coefficient with upper and lower entries.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['dfrac'],
    body: '\\dfrac{${1:numerator}}{${2:denominator}}$0',
    description: 'Display-style fraction, useful when ordinary \\frac would be too small.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['deriv', 'ddx'],
    body: '\\frac{d ${1:f}}{d ${2:x}}$0',
    description: 'Ordinary derivative written as a Leibniz fraction.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['pderiv', 'partiald'],
    body: '\\frac{\\partial ${1:f}}{\\partial ${2:x}}$0',
    description: 'First partial derivative written as a Leibniz fraction.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['nderiv'],
    body: '\\frac{d^{${1:n}} ${2:f}}{d ${3:x}^{${1:n}}}$0',
    description: 'Nth ordinary derivative with a mirrored derivative order.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['npderiv'],
    body: '\\frac{\\partial^{${1:n}} ${2:f}}{\\partial ${3:x}^{${1:n}}}$0',
    description: 'Nth partial derivative with a mirrored derivative order.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['sum'],
    body: '\\sum_{${1:i=1}}^{${2:n}} ${3:term}$0',
    description: 'Summation with lower bound, upper bound, and summand.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['prod'],
    body: '\\prod_{${1:i=1}}^{${2:n}} ${3:term}$0',
    description: 'Product with lower bound, upper bound, and factor.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['int'],
    body: '\\int_{${1:a}}^{${2:b}} ${3:f(x)} \\, d${4:x}$0',
    description: 'Definite integral with bounds, integrand, and differential.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['iint'],
    body: '\\iint_{${1:D}} ${2:f(x,y)} \\, d${3:x} \\, d${4:y}$0',
    description: 'Double integral with a domain, integrand, and two differentials.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['oint'],
    body: '\\oint_{${1:\\gamma}} ${2:\\omega}$0',
    description: 'Contour/closed integral with an editable cycle and integrand.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['lim'],
    body: '\\lim_{${1:x \\to a}} ${2:f(x)}$0',
    description: 'Limit with editable approach expression and body.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['bigcup'],
    body: '\\bigcup_{${1:i \\in I}} ${2:U_i}$0',
    description: 'Indexed union.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['bigcap'],
    body: '\\bigcap_{${1:i \\in I}} ${2:U_i}$0',
    description: 'Indexed intersection.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['xrightarrow', 'xrarrow'],
    body: '\\xrightarrow{${1:label}}$0',
    description: 'Right arrow with text or mathematics above it.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['xleftarrow', 'xlarrow'],
    body: '\\xleftarrow{${1:label}}$0',
    description: 'Left arrow with text or mathematics above it.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['overset'],
    body: '\\overset{${1:above}}{${2:base}}$0',
    description: 'Place an annotation above an expression.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['underset'],
    body: '\\underset{${1:below}}{${2:base}}$0',
    description: 'Place an annotation below an expression.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['overbrace'],
    body: '\\overbrace{${1:expression}}^{${2:annotation}}$0',
    description: 'Overbrace with an annotation above it.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['underbrace'],
    body: '\\underbrace{${1:expression}}_{${2:annotation}}$0',
    description: 'Underbrace with an annotation below it.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['substack'],
    body: '\\substack{${1:first} \\\\ ${2:second}}$0',
    description: 'Stack two lines in a subscript/superscript, commonly under sums and limits.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['operatorname', 'opname'],
    body: '\\operatorname{${1:name}}$0',
    description: 'Typeset a custom textual mathematical operator with operator spacing.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['text'],
    body: '\\text{${1:text}}$0',
    description: 'Insert ordinary text inside mathematics.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['cases', 'piecewise'],
    body: '\\begin{cases}\n\t${1:value} & ${2:condition} \\\\\n\t${3:value} & ${4:condition}\n\\end{cases}$0',
    description: 'Piecewise expression with a left brace and aligned condition column.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['mat', 'matrix'],
    body: '\\begin{matrix}\n\t${1:a} & ${2:b} \\\\\n\t${3:c} & ${4:d}\n\\end{matrix}$0',
    description: '2×2 matrix with no surrounding delimiters.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['bmat', 'bmatrix'],
    body: '\\begin{bmatrix}\n\t${1:a} & ${2:b} \\\\\n\t${3:c} & ${4:d}\n\\end{bmatrix}$0',
    description: '2×2 matrix delimited by square brackets [ ].',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['pmat', 'pmatrix'],
    body: '\\begin{pmatrix}\n\t${1:a} & ${2:b} \\\\\n\t${3:c} & ${4:d}\n\\end{pmatrix}$0',
    description: '2×2 matrix delimited by parentheses ( ).',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['vmat', 'vmatrix'],
    body: '\\begin{vmatrix}\n\t${1:a} & ${2:b} \\\\\n\t${3:c} & ${4:d}\n\\end{vmatrix}$0',
    description: '2×2 matrix/determinant delimited by single vertical bars | |.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['dvmat', 'doublevmat'],
    body: '\\begin{Vmatrix}\n\t${1:a} & ${2:b} \\\\\n\t${3:c} & ${4:d}\n\\end{Vmatrix}$0',
    description: '2×2 matrix delimited by double vertical bars ‖ ‖.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['aligned'],
    body: '\\begin{aligned}\n\t${1:left} &= ${2:right} \\\\\n\t${3:left} &= ${4:right}\n\\end{aligned}$0',
    description: 'Aligned equations for use inside an existing math display.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['gathered'],
    body: '\\begin{gathered}\n\t${1:first line} \\\\\n\t${2:second line}\n\\end{gathered}$0',
    description: 'Centered stack of equations inside an existing math display.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['array'],
    body: '\\begin{array}{${1:cc}}\n\t${2:a} & ${3:b} \\\\\n\t${4:c} & ${5:d}\n\\end{array}$0',
    description: 'Array with an editable column specification.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['setbuilder'],
    body: '\\left\\{ ${1:x} \\,\\middle|\\, ${2:condition} \\right\\}$0',
    description: 'Set-builder notation with automatically sized braces and a middle bar.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['paren', 'lrparen'],
    body: '\\left( ${1:expression} \\right)$0',
    description: 'Automatically sized parentheses.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['bracket', 'lrbracket'],
    body: '\\left[ ${1:expression} \\right]$0',
    description: 'Automatically sized square brackets.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['brace', 'lrbrace'],
    body: '\\left\\{ ${1:expression} \\right\\}$0',
    description: 'Automatically sized curly braces.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['abs'],
    body: '\\left| ${1:x} \\right|$0',
    description: 'Absolute value with automatically sized vertical bars.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['norm'],
    body: '\\left\\lVert ${1:x} \\right\\rVert$0',
    description: 'Norm with automatically sized double vertical delimiters.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['inner'],
    body: '\\left\\langle ${1:x}, ${2:y} \\right\\rangle$0',
    description: 'Inner-product/angle-bracket pair.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['floor'],
    body: '\\left\\lfloor ${1:x} \\right\\rfloor$0',
    description: 'Floor delimiters with automatic sizing.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['ceil'],
    body: '\\left\\lceil ${1:x} \\right\\rceil$0',
    description: 'Ceiling delimiters with automatic sizing.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['evalat', 'evaluate'],
    body: '\\left. ${1:f(x)} \\right|_{${2:x=a}}$0',
    description: 'Evaluate an expression at a specified value using a right evaluation bar.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['smallmat', 'smallmatrix'],
    body: '\\begin{smallmatrix}\n\t${1:a} & ${2:b} \\\\\n\t${3:c} & ${4:d}\n\\end{smallmatrix}$0',
    description: 'Compact 2×2 matrix suitable for inline mathematics; no surrounding delimiters.',
    source: 'LaTeX', context: 'math'
  },
  {
    triggers: ['draw'],
    body: '\\draw[${1:options}] ${2:path};$0',
    description: 'TikZ draw path with an optional style/options field.',
    source: 'TikZ', context: 'tikz'
  },
  {
    triggers: ['path'],
    body: '\\path[${1:options}] ${2:path};$0',
    description: 'TikZ path without an implied draw/fill operation.',
    source: 'TikZ', context: 'tikz'
  },
  {
    triggers: ['line'],
    body: '\\draw[${1:options}] (${2:0,0}) -- (${3:1,0});$0',
    description: 'Straight TikZ line segment between two coordinates.',
    source: 'TikZ', context: 'tikz'
  },
  {
    triggers: ['arrowline'],
    body: '\\draw[${1:->}] (${2:0,0}) -- (${3:1,0});$0',
    description: 'Straight TikZ arrow between two coordinates.',
    source: 'TikZ', context: 'tikz'
  },
  {
    triggers: ['node'],
    body: '\\node[${1:options}] (${2:name}) at (${3:0,0}) {${4:text}};$0',
    description: 'Named TikZ node with options, position, and contents.',
    source: 'TikZ', context: 'tikz'
  },
  {
    triggers: ['coord', 'coordinate'],
    body: '\\coordinate (${1:name}) at (${2:0,0});$0',
    description: 'Named TikZ coordinate.',
    source: 'TikZ', context: 'tikz'
  },
  {
    triggers: ['rect', 'rectangle'],
    body: '\\draw[${1:options}] (${2:0,0}) rectangle (${3:1,1});$0',
    description: 'TikZ rectangle specified by opposite corners.',
    source: 'TikZ', context: 'tikz'
  },
  {
    triggers: ['circle'],
    body: '\\draw[${1:options}] (${2:0,0}) circle (${3:1cm});$0',
    description: 'TikZ circle with center and radius.',
    source: 'TikZ', context: 'tikz'
  },
  {
    triggers: ['ellipse'],
    body: '\\draw[${1:options}] (${2:0,0}) ellipse (${3:1cm} and ${4:0.5cm});$0',
    description: 'TikZ ellipse with horizontal and vertical radii.',
    source: 'TikZ', context: 'tikz'
  },
  {
    triggers: ['grid'],
    body: '\\draw[${1:help lines}] (${2:0,0}) grid (${3:5,5});$0',
    description: 'TikZ rectangular grid over a bounding box.',
    source: 'TikZ', context: 'tikz'
  },
  {
    triggers: ['arc'],
    body: '\\draw[${1:options}] (${2:start}) arc[start angle=${3:0}, end angle=${4:90}, radius=${5:1cm}];$0',
    description: 'TikZ circular arc with explicit start/end angles and radius.',
    source: 'TikZ', context: 'tikz'
  },
  {
    triggers: ['bezier', 'curve'],
    body: '\\draw[${1:options}] (${2:start}) .. controls (${3:c1}) and (${4:c2}) .. (${5:end});$0',
    description: 'Cubic Bézier curve using two TikZ control points.',
    source: 'TikZ', context: 'tikz'
  },
  {
    triggers: ['foreach'],
    body: '\\foreach \\${1:x} in {${2:items}} {\n\t${3:\\draw ...;}\n}$0',
    description: 'TikZ foreach loop over a comma-separated item/range list.',
    source: 'TikZ', context: 'tikz'
  },
  {
    triggers: ['scope'],
    body: '\\begin{scope}[${1:options}]\n\t${2}\n\\end{scope}$0',
    description: 'TikZ scope for applying options/transforms to a group of drawing commands.',
    source: 'TikZ', context: 'tikz'
  },
  {
    triggers: ['filldraw'],
    body: '\\filldraw[${1:options}] ${2:path};$0',
    description: 'TikZ path with both fill and stroke.',
    source: 'TikZ', context: 'tikz'
  },
  {
    triggers: ['fill'],
    body: '\\fill[${1:options}] ${2:path};$0',
    description: 'Fill a TikZ path without drawing its outline.',
    source: 'TikZ', context: 'tikz'
  },
  {
    triggers: ['clip'],
    body: '\\clip ${1:path};$0',
    description: 'TikZ clipping path for subsequent drawing operations.',
    source: 'TikZ', context: 'tikz'
  },
  {
    triggers: ['tikzset', 'style'],
    body: '\\tikzset{${1:style name}/.style={${2:options}}}$0',
    description: 'Define a reusable TikZ style with \\tikzset.',
    source: 'TikZ', context: 'tikz'
  },
  {
    triggers: ['arrow', 'ar'],
    body: '\\arrow[${1:r}, "${2:label}"]$0',
    description: 'tikz-cd arrow with direction/options and a label.',
    source: 'tikzcd', context: 'tikzcd'
  },
  {
    triggers: ['rarrow'],
    body: '\\arrow[r, "${1:label}"]$0',
    description: 'tikz-cd right arrow with a label.',
    source: 'tikzcd', context: 'tikzcd'
  },
  {
    triggers: ['larrow'],
    body: '\\arrow[l, "${1:label}"]$0',
    description: 'tikz-cd left arrow with a label.',
    source: 'tikzcd', context: 'tikzcd'
  },
  {
    triggers: ['darrow'],
    body: '\\arrow[d, "${1:label}"]$0',
    description: 'tikz-cd downward arrow with a label.',
    source: 'tikzcd', context: 'tikzcd'
  },
  {
    triggers: ['uarrow'],
    body: '\\arrow[u, "${1:label}"]$0',
    description: 'tikz-cd upward arrow with a label.',
    source: 'tikzcd', context: 'tikzcd'
  },
  {
    triggers: ['bendleft'],
    body: '\\arrow[${1:r}, bend left=${2:20}, "${3:label}"]$0',
    description: 'tikz-cd bent arrow; useful for parallel morphisms.',
    source: 'tikzcd', context: 'tikzcd'
  },
  {
    triggers: ['bendright'],
    body: '\\arrow[${1:r}, bend right=${2:20}, "${3:label}"]$0',
    description: 'tikz-cd arrow bent in the opposite direction.',
    source: 'tikzcd', context: 'tikzcd'
  },
  {
    triggers: ['hookarrow'],
    body: '\\arrow[${1:r}, hook, "${2:label}"]$0',
    description: 'tikz-cd hook arrow, conventionally used for monomorphisms.',
    source: 'tikzcd', context: 'tikzcd'
  },
  {
    triggers: ['twoheadarrow'],
    body: '\\arrow[${1:r}, two heads, "${2:label}"]$0',
    description: 'tikz-cd two-headed arrow, conventionally used for epimorphisms.',
    source: 'tikzcd', context: 'tikzcd'
  }
]

function contextAllows (construction: Construction, ctx: CompletionContext): boolean {
  const tikz = tikzBlockAt(ctx.state, ctx.pos)
  if (construction.context === 'tikzcd') return tikz?.language === 'tikzcd'
  if (construction.context === 'tikz') return tikz !== null
  return isMathPosition(ctx.state, ctx.pos)
}

function optionFor (construction: Construction, trigger: string): Completion {
  return {
    label: trigger,
    detail: construction.description,
    type: 'text',
    boost: 10,
    zettlrSource: construction.source,
    info: () => completionInfoPanel({
      title: trigger,
      source: construction.source,
      description: construction.description,
      syntax: 'construction snippet',
      insertion: construction.body
    }),
    apply (view, completion, from, to) {
      codeMirrorSnippet(construction.body)(view, completion, from, to)
    }
  } as Completion
}

export const texConstructionSource: CompletionSource = (ctx): CompletionResult|null => {
  const word = ctx.matchBefore(/[A-Za-z][A-Za-z0-9]*$/u)
  if (word === null || (!ctx.explicit && word.text.length < 2)) return null

  const needle = word.text.toLocaleLowerCase()
  const options = CONSTRUCTIONS
    .filter(construction => contextAllows(construction, ctx))
    .flatMap(construction => construction.triggers.map(trigger => ({ construction, trigger })))
    .filter(({ trigger }) => trigger.toLocaleLowerCase().startsWith(needle))
    .map(({ construction, trigger }) => optionFor(construction, trigger))

  return options.length === 0 ? null : { from: word.from, options }
}

export const __texConstructionsForTests = CONSTRUCTIONS
