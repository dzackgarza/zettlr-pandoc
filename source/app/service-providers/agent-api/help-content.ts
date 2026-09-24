/**
 * The agent API's authoring guide (GET /help). HELP.md at the repository root
 * is its only prose source; webpack embeds it as a string (asset/source). The
 * theorem-family table is generated from THEOREM_FAMILY_METADATA, the list the
 * editor and the linter use, so the guide cannot name a family they do not know.
 */

import { THEOREM_FAMILY_METADATA } from "@common/util/pandoc-quick-reference";
import helpDocument from "../../../../HELP.md";

const THEOREM_FAMILIES_MARKER = "<!-- theorem-families -->";

function theoremFamilyTable(): string {
  const rows = THEOREM_FAMILY_METADATA.map(
    (family) => `| ${family.displayName} | \`.${family.divClass}\` | \`#${family.prefix}:key\` |`,
  );
  return ["| Block | Class | ID |", "|---|---|---|", ...rows].join("\n");
}

if (!helpDocument.includes(THEOREM_FAMILIES_MARKER)) {
  throw new Error(`HELP.md must contain ${THEOREM_FAMILIES_MARKER}`);
}

export const HELP_DOCUMENT: string = helpDocument.replace(
  THEOREM_FAMILIES_MARKER,
  theoremFamilyTable(),
);
