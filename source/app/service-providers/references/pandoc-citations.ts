import { execFile } from "node:child_process";
import {
  type Citation,
  type CiteItem,
  parseCitationSuffix,
} from "@common/modules/markdown-editor/parser/citation-parser";
import { extractASTNodes, markdownToAST } from "@common/modules/markdown-utils";
import { LRUCache } from "lru-cache";
import { z } from "zod";

const json = z.json();
type PandocJSON = z.infer<typeof json>;
const citationItems = z.array(
  z.object({
    citationId: z.string(),
    citationPrefix: z.array(json),
    citationSuffix: z.array(json),
    citationMode: z.object({ t: z.enum(["NormalCitation", "SuppressAuthor", "AuthorInText"]) }),
  }),
);
const documentSchema = z.object({
  blocks: z.array(
    z.object({
      t: z.literal("Div"),
      c: z.tuple([
        z.tuple([z.string(), z.array(z.string()), z.array(z.tuple([z.string(), z.string()]))]),
        z.array(json),
      ]),
    }),
  ),
});

function citationCandidates(source: string): Citation[] {
  return extractASTNodes(markdownToAST(source), "Citation").flatMap((node) =>
    node.type === "Citation" ? [node.parsedCitation] : [],
  );
}

/** What Pandoc reads in the source of one candidate. */
interface PandocReading {
  /** Absent when Pandoc does not consume the whole source as one citation. */
  citation?: Pick<Citation, "items" | "composite">;
}

// Pandoc reads each candidate alone in its own Div, so its reading depends
// only on the source of the candidate. A document that was read before needs
// Pandoc again only for the candidates that an edit changed.
const readings = new LRUCache<string, PandocReading>({ max: 20000 });

/** The citations of `candidates`, or undefined when Pandoc did not read one of them yet. */
function citationsFromReadings(candidates: Citation[]): Citation[] | undefined {
  const citations: Citation[] = [];
  for (const candidate of candidates) {
    const reading = readings.get(candidate.source);
    if (reading === undefined) return undefined;
    if (reading.citation !== undefined) citations.push({ ...candidate, ...reading.citation });
  }
  return citations;
}

/**
 * The Pandoc citations of `source` when Pandoc read each of its candidates
 * before, without a Pandoc process; else undefined.
 */
export function knownPandocCitations(source: string): Citation[] | undefined {
  return citationsFromReadings(citationCandidates(source));
}

function inlineText(value: PandocJSON): string {
  if (Array.isArray(value)) return value.map(inlineText).join("");
  if (value === null || typeof value !== "object") return "";
  if (value.t === "Str" && typeof value.c === "string") return value.c;
  if (value.t === "Space" || value.t === "SoftBreak" || value.t === "LineBreak") return " ";
  if (value.t === "Code" && Array.isArray(value.c) && typeof value.c[1] === "string")
    return value.c[1];
  return value.c === undefined ? "" : inlineText(value.c);
}

const citationParagraph = z
  .array(
    z.object({
      t: z.literal("Para"),
      c: z
        .array(z.object({ t: z.literal("Cite"), c: z.tuple([citationItems, z.array(json)]) }))
        .length(1),
    }),
  )
  .length(1);

/**
 * Pandoc owns citation IDs, modes and affixes; the editor owns source ranges.
 * Indexed Divs retain those ranges without searching normalized Pandoc text.
 * The candidates come from the complete document tree, excluding code and metadata.
 * https://pandoc.org/MANUAL.html#citations
 * https://hackage.haskell.org/package/pandoc-types/docs/Text-Pandoc-Definition.html
 */
export async function extractPandocCitations(source: string): Promise<Citation[]> {
  const candidates = citationCandidates(source);
  const unread = [...new Set(candidates.map((candidate) => candidate.source))].filter(
    (candidateSource) => !readings.has(candidateSource),
  );
  if (unread.length > 0) await readWithPandoc(unread);
  const citations = citationsFromReadings(candidates);
  if (citations === undefined) {
    throw new Error(
      `The document has more distinct citations than the ${readings.max} that the reading cache holds`,
    );
  }
  return citations;
}

/** Reads each candidate source with one Pandoc process and keeps the readings. */
async function readWithPandoc(candidateSources: string[]): Promise<void> {
  const sources = new Map(
    candidateSources.map((candidateSource, index) => [`citation-${index}`, candidateSource]),
  );
  const fence = ":".repeat(
    Math.max(
      3,
      ...candidateSources.flatMap((candidateSource) =>
        Array.from(candidateSource.matchAll(/^:{3,}/gm), (match) => match[0].length + 1),
      ),
    ),
  );
  const input = candidateSources
    .map((candidateSource, index) => `${fence} {#citation-${index}}\n${candidateSource}\n${fence}`)
    .join("\n\n");
  const output = await new Promise<string>((resolve, reject) => {
    const process = execFile(
      "pandoc",
      ["--from=markdown", "--to=json"],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) reject(error);
        else resolve(stdout);
      },
    );
    if (process.stdin === null) throw new Error("Pandoc input stream is unavailable");
    process.stdin.on("error", reject);
    process.stdin.end(input);
  });
  const document = documentSchema.parse(JSON.parse(output));
  if (document.blocks.length !== candidateSources.length) {
    throw new Error(
      `Pandoc returned ${document.blocks.length} blocks for ${candidateSources.length} citation sources`,
    );
  }
  for (const block of document.blocks) {
    const candidateSource = sources.get(block.c[0][0]);
    if (candidateSource === undefined)
      throw new Error("Pandoc returned an unrecognized citation source range");
    const paragraph = citationParagraph.safeParse(block.c[1]);
    // A candidate is replaceable only when Pandoc consumes its entire range.
    if (!paragraph.success) {
      readings.set(candidateSource, {});
      continue;
    }
    const cluster = paragraph.data[0].c[0].c[0];
    const items = cluster.map((item) => {
      // CSL's locator is an interpretation of the Pandoc suffix. Reuse the
      // shared CSL locator adapter after Pandoc normalizes affixes.
      const result: CiteItem = {
        id: item.citationId,
        ...parseCitationSuffix(inlineText(item.citationSuffix)),
      };
      const prefix = inlineText(item.citationPrefix);
      if (prefix !== "") result.prefix = prefix;
      if (item.citationMode.t === "SuppressAuthor") result["suppress-author"] = true;
      return result;
    });
    readings.set(candidateSource, {
      citation: { items, composite: cluster[0].citationMode.t === "AuthorInText" },
    });
  }
}
