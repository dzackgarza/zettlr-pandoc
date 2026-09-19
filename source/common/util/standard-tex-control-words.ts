/** Maintained standard LaTeX control-word catalogue, renderer-independent. */

import latexWorkshopCommands from "../../../static/autocomplete/latex-workshop-commands.json";

function commandName(key: string): string | null {
  const match = /^[A-Za-z@]+/u.exec(key);
  return match === null ? null : match[0];
}

const STANDARD_TEX_CONTROL_WORDS = new Set<string>();
for (const key of Object.keys(latexWorkshopCommands)) {
  const name = commandName(key);
  if (name !== null) {
    STANDARD_TEX_CONTROL_WORDS.add(`\\${name}`);
  }
}

/** A fresh set so callers cannot mutate the process-global catalogue. */
export function standardTexControlWords(): ReadonlySet<string> {
  return new Set(STANDARD_TEX_CONTROL_WORDS);
}
