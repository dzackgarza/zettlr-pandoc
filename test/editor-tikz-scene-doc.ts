/**
 * The shared TikZ visual scene document (issue #14): imported by the page
 * entry (which mounts the editor and lightbox) and by the capture harness's
 * main process (which computes real render results for its blocks). Kept
 * Vue-free so the harness can require it under tsx.
 */

export const SCENE_DOC = `# TikZ scenes

A commutative square, authored as a raw block:

\\begin{tikzcd}
A \\arrow[r, "f"] \\arrow[d, "g"'] & B \\arrow[d, "h"] \\\\
C \\arrow[r, "k"'] & D
\\end{tikzcd}

A picture environment:

\\begin{tikzpicture}
\\draw[->] (0,0) -- (2,0) node[right] {$x$};
\\draw[->] (0,0) -- (0,2) node[above] {$y$};
\\draw (0,0) circle (1);
\\end{tikzpicture}

A broken figure whose diagnostic must surface:

\\begin{tikzcd}
A \\arrow[r] & B \\thisMacroDoesNotExist
\\end{tikzcd}

The trailing paragraph keeps the caret away from the figures.
`

/**
 * Textbook-scale visual audit corpus. These scenes intentionally mirror common
 * diagram families visible in nLab, Kerodon, the Stacks Project, and ordinary
 * research monographs: small universal-property shapes, medium diagram chases,
 * and legitimately wide exact/spectral diagrams.
 */
export const TEXTBOOK_SMALL_SCENE_DOC = `# Textbook TikZ scale — small diagrams

Cospan / pullback input shape:

\\begin{tikzcd}[column sep=large]
A \\arrow[dr, "f"'] && B \\arrow[dl, "g"] \\\\
& C &
\\end{tikzcd}

Small triangle, as in short morphism-factorisation diagrams:

\\begin{tikzcd}[row sep=large,column sep=large]
Z \\arrow[r, "i"] \\arrow[dr, "j"'] & X \\arrow[d] \\\\
& Y
\\end{tikzcd}

Ordinary commutative square:

\\begin{tikzcd}[row sep=large,column sep=large]
A \\arrow[r, "f"] \\arrow[d, "g"'] & B \\arrow[d, "h"] \\\\
C \\arrow[r, "k"'] & D
\\end{tikzcd}

L-shaped fibre sequence fragment:

\\begin{tikzcd}[row sep=large,column sep=large]
& E \\arrow[d] \\\\
F \\arrow[r] & B
\\end{tikzcd}
`

export const TEXTBOOK_MEDIUM_SCENE_DOC = `# Textbook TikZ scale — medium diagrams

Short exact sequence:

\\begin{tikzcd}[column sep=normal]
0 \\arrow[r] & A \\arrow[r, "i"] & B \\arrow[r, "p"] & C \\arrow[r] & 0
\\end{tikzcd}

Two pasted commutative squares:

\\begin{tikzcd}[row sep=large,column sep=large]
A \\arrow[r] \\arrow[d] & B \\arrow[r] \\arrow[d] & C \\arrow[d] \\\\
D \\arrow[r] & E \\arrow[r] & F
\\end{tikzcd}

A 3-by-3 diagram chase:

\\begin{tikzcd}[row sep=normal,column sep=normal]
A_1 \\arrow[r] \\arrow[d] & A_2 \\arrow[r] \\arrow[d] & A_3 \\arrow[d] \\\\
B_1 \\arrow[r] \\arrow[d] & B_2 \\arrow[r] \\arrow[d] & B_3 \\arrow[d] \\\\
C_1 \\arrow[r] & C_2 \\arrow[r] & C_3
\\end{tikzcd}
`

export const TEXTBOOK_WIDE_SCENE_DOC = `# Textbook TikZ scale — wide diagrams

Snake-lemma style ladder with exact rows:

\\begin{tikzcd}[row sep=large,column sep=normal]
0 \\arrow[r] & X \\arrow[r] \\arrow[d, "\\alpha"'] & Y \\arrow[r] \\arrow[d, "\\beta"] & Z \\arrow[r] \\arrow[d, "\\gamma"] & 0 \\\\
0 \\arrow[r] & U \\arrow[r] & V \\arrow[r] & W \\arrow[r] & 0
\\end{tikzcd}

A long exact row should become wide because its TeX box is wide:

\\begin{tikzcd}[column sep=normal]
0 \\arrow[r] & A_0 \\arrow[r] & A_1 \\arrow[r] & A_2 \\arrow[r] & A_3 \\arrow[r] & A_4 \\arrow[r] & A_5 \\arrow[r] & A_6 \\arrow[r] & 0
\\end{tikzcd}

A genuinely large spectral-sequence page may approach the full measure:

\\begin{tikzcd}[row sep=small,column sep=small]
E_2^{0,3} & E_2^{1,3} & E_2^{2,3} & E_2^{3,3} & E_2^{4,3} & E_2^{5,3} & E_2^{6,3} & E_2^{7,3} & E_2^{8,3} & E_2^{9,3} & E_2^{10,3} & E_2^{11,3} \\\\
E_2^{0,2} & E_2^{1,2} & E_2^{2,2} & E_2^{3,2} & E_2^{4,2} & E_2^{5,2} & E_2^{6,2} & E_2^{7,2} & E_2^{8,2} & E_2^{9,2} & E_2^{10,2} & E_2^{11,2} \\\\
E_2^{0,1} \\arrow[rru] & E_2^{1,1} \\arrow[rru] & E_2^{2,1} \\arrow[rru] & E_2^{3,1} \\arrow[rru] & E_2^{4,1} \\arrow[rru] & E_2^{5,1} \\arrow[rru] & E_2^{6,1} \\arrow[rru] & E_2^{7,1} \\arrow[rru] & E_2^{8,1} \\arrow[rru] & E_2^{9,1} & E_2^{10,1} & E_2^{11,1} \\\\
E_2^{0,0} & E_2^{1,0} & E_2^{2,0} & E_2^{3,0} & E_2^{4,0} & E_2^{5,0} & E_2^{6,0} & E_2^{7,0} & E_2^{8,0} & E_2^{9,0} & E_2^{10,0} & E_2^{11,0}
\\end{tikzcd}
`
