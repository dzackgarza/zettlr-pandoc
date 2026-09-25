/**
 * Exact Stacks Project diagram references used by the TikZ visual oracle.
 *
 * `xymatrix` is copied from the referenced tag page and is checked against the
 * live page before capture. `tikz` is the equivalent source rendered through
 * Zettlr's production TikZ pipeline. The visual driver captures both sides and
 * compares their widths after normalising by each page's body/editor font.
 */

export interface StacksDiagramReference {
  id: string
  /** Index within #tag .equation on the Stacks page. */
  equationIndex: number
  xymatrix: string
  tikz: string
}

export interface StacksPageReference {
  tag: string
  title: string
  url: string
  diagrams: StacksDiagramReference[]
}

export const STACKS_TIKZ_REFERENCES: StacksPageReference[] = [
  {
    tag: '01JO',
    title: 'Fibre products of schemes',
    url: 'https://stacks.math.columbia.edu/tag/01JO',
    diagrams: [
      {
        id: 'fibre-product-square',
        equationIndex: 0,
        xymatrix: String.raw`\xymatrix{ X \times _ S Y \ar[r]_ q \ar[d]_ p &  Y \ar[d]^ g \\  X \ar[r]^ f &  S }`,
        tikz: String.raw`\begin{tikzcd}
X \times_S Y \arrow[r, "q"'] \arrow[d, "p"'] & Y \arrow[d, "g"] \\
X \arrow[r, "f"] & S
\end{tikzcd}`
      },
      {
        id: 'universal-cone',
        equationIndex: 1,
        xymatrix: String.raw`\xymatrix{ T \ar[rrrd] \ar@{-->}[rrd] \ar[rrdd] &  &  \\  &  &  X \times _ S Y \ar[d] \ar[r] &  Y \ar[d] \\  &  &  X \ar[r] &  S }`,
        tikz: String.raw`\begin{tikzcd}
T \arrow[rrrd] \arrow[rrd, dashed] \arrow[rrdd] & & & \\
& & X \times_S Y \arrow[d] \arrow[r] & Y \arrow[d] \\
& & X \arrow[r] & S
\end{tikzcd}`
      },
      {
        id: 'residue-field-cone',
        equationIndex: 4,
        xymatrix: String.raw`\xymatrix{ X \times _ S Y \ar@/_/[dddr] \ar@/^/[rrrd] &  &  &  \\  &  \mathop{\mathrm{Spec}}(\kappa (x) \otimes _{\kappa (s)} \kappa (y)/\mathfrak p) \ar[r] \ar[d] \ar@{-->}[lu] &  \mathop{\mathrm{Spec}}(\kappa (y)) \ar[d] \ar[r] &  Y \ar[dd] \\  &  \mathop{\mathrm{Spec}}(\kappa (x)) \ar[r] \ar[d] &  \mathop{\mathrm{Spec}}(\kappa (s)) \ar[rd] &  \\  &  X \ar[rr] &  &  S }`,
        tikz: String.raw`\begin{tikzcd}
X \times_S Y \arrow[dddr, bend right] \arrow[rrrd, bend left] & & & \\
& \operatorname{Spec}(\kappa(x) \otimes_{\kappa(s)} \kappa(y)/\mathfrak p) \arrow[r] \arrow[d] \arrow[lu, dashed] & \operatorname{Spec}(\kappa(y)) \arrow[d] \arrow[r] & Y \arrow[dd] \\
& \operatorname{Spec}(\kappa(x)) \arrow[r] \arrow[d] & \operatorname{Spec}(\kappa(s)) \arrow[rd] & \\
& X \arrow[rr] & & S
\end{tikzcd}`
      }
    ]
  },
  {
    tag: '07JW',
    title: 'Snake lemma',
    url: 'https://stacks.math.columbia.edu/tag/07JW',
    diagrams: [
      {
        id: 'snake-ladder',
        equationIndex: 0,
        xymatrix: String.raw`\xymatrix{ &  X \ar[r] \ar[d]^\alpha &  Y \ar[r] \ar[d]^\beta &  Z \ar[r] \ar[d]^\gamma &  0 \\  0 \ar[r] &  U \ar[r] &  V \ar[r] &  W }`,
        tikz: String.raw`\begin{tikzcd}
& X \arrow[r] \arrow[d, "\alpha"] & Y \arrow[r] \arrow[d, "\beta"] & Z \arrow[r] \arrow[d, "\gamma"] & 0 \\
0 \arrow[r] & U \arrow[r] & V \arrow[r] & W
\end{tikzcd}`
      }
    ]
  },
  {
    tag: '067L',
    title: 'Sheaf of differentials triangle',
    url: 'https://stacks.math.columbia.edu/tag/067L',
    diagrams: [
      {
        id: 'immersion-triangle',
        equationIndex: 0,
        xymatrix: String.raw`\xymatrix{ Z \ar[r]_ i \ar[rd]_ j &  X \ar[d] \\  &  Y }`,
        tikz: String.raw`\begin{tikzcd}
Z \arrow[r, "i"'] \arrow[rd, "j"'] & X \arrow[d] \\
& Y
\end{tikzcd}`
      }
    ]
  }
]

export function stacksReplicaDocument (tag: string): string {
  const reference = STACKS_TIKZ_REFERENCES.find(page => page.tag === tag)
  if (reference === undefined) {
    throw new Error(`Unknown Stacks TikZ reference tag ${tag}`)
  }
  return [
    `# Stacks ${reference.tag} — ${reference.title}`,
    '',
    ...reference.diagrams.flatMap(diagram => [
      `${diagram.id}:`,
      '',
      diagram.tikz,
      ''
    ])
  ].join('\n')
}

