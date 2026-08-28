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
`;
