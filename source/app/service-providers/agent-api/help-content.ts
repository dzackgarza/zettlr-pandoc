/**
 * Compiled help documentation and runtime resolver.
 */

import fs from "fs";
import path from "path";

export const COMPILED_HELP_DOCUMENT = `# Figure authoring

Use Pandoc Markdown attributes for figures and references.

## Images

\`\`\`markdown
![Figure caption](path/to/image.png){#fig:example}
\`\`\`

Optional attributes go in the same braces:

\`\`\`markdown
![Figure caption](path/to/image.png){#fig:example width=80%}
\`\`\`

Figure IDs use the \`fig:\` prefix.

## Figure groups

\`\`\`markdown
::: {#fig:comparison}
![Left caption](left.png){#fig:left}

![Right caption](right.png){#fig:right}

Caption for the complete group.
:::
\`\`\`

Give the group and each subfigure its own \`fig:\` ID. Put the group caption in the final paragraph.

## TikZ

Use a \`tikz\` fence for ordinary TikZ:

\`\`\`\`markdown
\`\`\`tikz
\\draw (0,0) -- (1,1);
\`\`\`
\`\`\`\`

Use \`tikzcd\` for commutative diagrams:

\`\`\`\`markdown
\`\`\`tikzcd
A \\arrow[r, "f"] & B
\`\`\`
\`\`\`\`

Raw environments are also supported:

\`\`\`latex
\\begin{tikzpicture}
\\draw (0,0) -- (1,1);
\\end{tikzpicture}
\`\`\`

Shared figure files can be included with \`\\input\`:

\`\`\`latex
\\input{diagrams/example.tikz}
\`\`\`

## References

- \`@fig:example\` — normal reference
- \`[@fig:example]\` — parenthesized reference
- \`[@fig:left; @fig:right]\` — multiple references
- \`[See @fig:example]\` — text before the reference
- \`[-@fig:example]\` — suppress the automatic figure label
`;

export function resolveHelpDocument(extraSearchPaths: string[] = []): string {
  const candidatePaths = [
    ...extraSearchPaths,
    path.join(__dirname, "HELP.md"),
    path.join(__dirname, "assets", "HELP.md"),
    path.join(__dirname, "../../../../HELP.md"),
    path.join(process.cwd(), "HELP.md"),
  ];

  for (const candidate of candidatePaths) {
    try {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate, "utf8");
      }
    } catch {
      // Fall through to next candidate
    }
  }

  return COMPILED_HELP_DOCUMENT;
}
