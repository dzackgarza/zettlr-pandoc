/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        DatabaseLoader
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Contains the logic for loading Citation databases.
 *
 * END HEADER
 */

import { sha256Text } from "@common/util/sha256";
import { parse as parseBibTex } from "astrocite-bibtex";
import { BibLatexParser, CSLExporter } from "biblatex-csl-converter";
import { promises as fs } from "fs";
import path from "path";
import writeFileAtomic from "write-file-atomic";
import YAML from "yaml";
import type LogProvider from "../../log";
import type { DatabaseRecord } from "..";
import extractBibTexAttachments from "./extract-bibtex-attachments";

/**
 * Bump when the cached record's shape or the parser producing it changes:
 * a version mismatch is a cache miss, never an error.
 */
const BIB_CACHE_VERSION = 1;

/** What a .bib parse costs is what this file exists to avoid re-paying. */
interface BibCacheFile {
  version: number;
  sourceSha256: string;
  type: DatabaseRecord["type"];
  cslData: DatabaseRecord["cslData"];
  bibtexAttachments: DatabaseRecord["bibtexAttachments"];
}

/** One cache file per database, keyed by the canonical database path. */
function bibCachePath(cacheDir: string, databasePath: string): string {
  return path.join(cacheDir, `${sha256Text(path.resolve(databasePath))}.json`);
}

/**
 * The cached parse of this exact source text, or undefined on any miss —
 * absent file, older version, or a source hash that no longer matches. A
 * cache never fails: whatever is wrong with it, the parser is the answer.
 */
async function readBibCache(
  cacheDir: string,
  databasePath: string,
  sourceSha256: string,
  logger?: LogProvider,
): Promise<DatabaseRecord | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(bibCachePath(cacheDir, databasePath), "utf8");
  } catch {
    return undefined; // No cache yet: the ordinary first-run miss.
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger?.warning(`[Citeproc] Ignoring unreadable parse cache for ${databasePath}; re-parsing.`);
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    !("sourceSha256" in parsed) ||
    !("type" in parsed) ||
    !("cslData" in parsed) ||
    !("bibtexAttachments" in parsed)
  ) {
    logger?.warning(`[Citeproc] Ignoring malformed parse cache for ${databasePath}; re-parsing.`);
    return undefined;
  }
  const cache = parsed as BibCacheFile;
  if (cache.version !== BIB_CACHE_VERSION || cache.sourceSha256 !== sourceSha256) {
    return undefined; // The database (or the cache format) moved on.
  }
  logger?.info(
    `Loaded database ${path.basename(databasePath)} from parse cache (${Object.keys(cache.cslData).length} items).`,
  );
  return {
    path: databasePath,
    type: cache.type,
    cslData: cache.cslData,
    bibtexAttachments: cache.bibtexAttachments,
  };
}

/** Persist a finished parse so the next boot loads JSON instead of parsing. */
async function writeBibCache(
  cacheDir: string,
  databasePath: string,
  sourceSha256: string,
  record: DatabaseRecord,
  logger?: LogProvider,
): Promise<void> {
  const payload: BibCacheFile = {
    version: BIB_CACHE_VERSION,
    sourceSha256,
    type: record.type,
    cslData: record.cslData,
    bibtexAttachments: record.bibtexAttachments,
  };
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    await writeFileAtomic(bibCachePath(cacheDir, databasePath), JSON.stringify(payload));
  } catch (err) {
    // A failed cache write costs the next boot a parse, nothing more — but
    // it should not fail THIS load, which already has its record.
    logger?.warning(`[Citeproc] Could not write parse cache for ${databasePath}: ${String(err)}`);
  }
}

/**
 * Load the provided database into a DatabaseRecord.
 *
 * @param   {string}                   databasePath  The database path
 *
 * @return  {Promise<DatabaseRecord>}                The DatabaseRecord.
 */
export async function loadDatabase(
  databasePath: string,
  logger?: LogProvider,
  cacheDir?: string,
): Promise<DatabaseRecord> {
  const filenameExtension = path.extname(databasePath).toLowerCase();
  switch (filenameExtension) {
    case ".json":
      logger?.info(`Loading database ${path.basename(databasePath)} as CSL JSON.`);
      return await loadJSON(databasePath, logger);
    case ".yml":
    case ".yaml":
      logger?.info(`Loading database ${path.basename(databasePath)} as CSL YAML.`);
      return await loadYAML(databasePath, logger);
    case ".bib": {
      // Parsing a large .bib is by far the most expensive step of app boot
      // (a 2.4 MB library measured ~25 s), so the finished parse is cached
      // against the file's content hash: an unchanged database loads as
      // JSON in milliseconds, an edited one re-parses.
      const data = await fs.readFile(databasePath, "utf8");
      const sourceSha256 = sha256Text(data);
      if (cacheDir !== undefined) {
        const cached = await readBibCache(cacheDir, databasePath, sourceSha256, logger);
        if (cached !== undefined) {
          return cached;
        }
      }
      // NOTE: ASSUMPTION: Since BibTeX and BibLaTeX share the same file
      // endings, we first attempt to load it as BibLaTeX and if it throws we
      // fall back to BibTeX.
      let record: DatabaseRecord;
      try {
        logger?.info(`Loading database ${path.basename(databasePath)} as BibLaTeX.`);
        record = await loadBibLaTeX(databasePath, data, logger);
      } catch {
        logger?.info(
          `Loading database ${path.basename(databasePath)} as BibLaTeX failed. Falling back to loading as BibTeX.`,
        );
        record = await loadBibTeX(databasePath, data, logger);
      }
      if (cacheDir !== undefined) {
        await writeBibCache(cacheDir, databasePath, sourceSha256, record, logger);
      }
      return record;
    }
    default:
      throw new Error(`Could not load database ${databasePath}: Unknown extension`);
  }
}

/**
 * Loads a JSON database.
 *
 * @param   {string}                   databasePath  The database path
 *
 * @return  {Promise<DatabaseRecord>}                The record
 */
async function loadJSON(databasePath: string, logger?: LogProvider): Promise<DatabaseRecord> {
  const record: DatabaseRecord = {
    path: databasePath,
    type: "csl",
    cslData: {},
    bibtexAttachments: {},
  };

  const data = await fs.readFile(databasePath, "utf8");

  const parsedData: unknown = JSON.parse(data);

  if (!Array.isArray(parsedData)) {
    throw new Error(`Cannot parse CSL JSON database ${databasePath}: JSON was not an array.`);
  }

  // NOTE February 19, 2026: After receiving reports of users not being able to
  // get citekeys to autocomplete, I found out by looking at a problematic CSL
  // JSON file that due to the 8.0.3 update of Zotero, one item was missing its
  // citekey. For the past almost decade, Zettlr could assume that the CSL JSON
  // produced by Zotero was sane, because we always cast the parsed JSON data as
  // citekey and be done with it. To improve app stability, we're going to treat
  // each item as unknown before loading it now. This also guards against future
  // issues.
  // NOTE for the tinfoil hatters among you: I am strongly convinced that this
  // is a mere aleatoric event that could've happened eight years ago, but
  // didn't. It's in my opinion not a sign of software rot (unless it becomes
  // part of a pattern), but just a silly coincidence. No references were harmed
  // in producing this fix.
  for (const item of parsedData as unknown[]) {
    if (!(item instanceof Object)) {
      logger?.error("[Citeproc] Refusing to load CSL item: Not an object.", item);
      continue;
    }

    if (
      !("id" in item) ||
      !("type" in item) ||
      typeof item.id !== "string" ||
      typeof item.type !== "string"
    ) {
      logger?.error(
        "[Citeproc] Refusing to load CSL item: Required properties id or type were either not present, or the wrong type.",
        item,
      );
      continue;
    }

    record.cslData[item.id] = item as CSLItem;
  }

  logger?.info(`CSL JSON database loaded, ${Object.keys(record.cslData).length} items.`);

  return record;
}

/**
 * Loads a YAML database file.
 *
 * @param   {string}                   databasePath  The database
 *
 * @return  {Promise<DatabaseRecord>}                The record
 */
async function loadYAML(databasePath: string, logger?: LogProvider): Promise<DatabaseRecord> {
  const record: DatabaseRecord = {
    path: databasePath,
    type: "csl",
    cslData: {},
    bibtexAttachments: {},
  };

  // First read in the database file
  const data = await fs.readFile(databasePath, "utf8");

  let yamlData: unknown = YAML.parse(data);
  if (typeof yamlData === "object" && yamlData !== null && "references" in yamlData) {
    yamlData = (yamlData as { references: unknown }).references; // CSL YAML is stored in `references`
  }
  if (!Array.isArray(yamlData)) {
    throw new Error("The CSL YAML file did not contain valid contents.");
  }

  for (const item of yamlData as unknown[]) {
    if (!(item instanceof Object) || !("id" in item) || typeof item.id !== "string") {
      logger?.error("[Citeproc] Refusing to load CSL YAML item: missing string id.", item);
      continue;
    }
    record.cslData[item.id] = item as CSLItem;
  }

  logger?.info(`CSL JSON database loaded, ${Object.keys(record.cslData).length} items.`);

  return record;
}

/**
 * Loads a BibTeX database
 *
 * @param   {string}                   databasePath  The database file
 *
 * @return  {Promise<DatabaseRecord>}                The record
 */
async function loadBibTeX(
  databasePath: string,
  data: string,
  logger?: LogProvider,
): Promise<DatabaseRecord> {
  const record: DatabaseRecord = {
    path: databasePath,
    type: "bibtex",
    cslData: {},
    bibtexAttachments: {},
  };

  for (const item of parseBibTex(data)) {
    record.cslData[item.id] = item;
  }

  // If we're here, we had a BibTex library --> extract the attachments
  const attachments = extractBibTexAttachments(data, path.dirname(databasePath));
  record.bibtexAttachments = attachments;

  logger?.info(
    `BibTeX database loaded, ${Object.keys(record.cslData).length} items; ${record.bibtexAttachments.length} attachments found.`,
  );

  return record;
}

/**
 * Loads a BibLaTeX database
 *
 * @param   {string}                   databasePath  The database file
 *
 * @return  {Promise<DatabaseRecord>}                The record
 */
async function loadBibLaTeX(
  databasePath: string,
  data: string,
  logger?: LogProvider,
): Promise<DatabaseRecord> {
  const record: DatabaseRecord = {
    path: databasePath,
    type: "biblatex",
    cslData: {},
    bibtexAttachments: {},
  };

  const parser = new BibLatexParser(data, { processUnexpected: true, processUnknown: true });
  const bib = await parser.parseAsync();

  const cslExporter = new CSLExporter(bib.entries, false, {
    useEntryKeys: true,
  });

  const cslOutput = cslExporter.parse();
  for (const [key, item] of Object.entries(cslOutput)) {
    // NOTE: This is a type difference between CSLEntry and CSLItem, but the
    // library does assign the type property currently (I checked the source).
    record.cslData[key] = item as CSLItem;
  }

  // Now we also have to extract file fields (if they have been exported). The
  // BibLaTeX parser counts it as an unexpected field, accessible from
  // bib.entries[idx].unexpected_fields.file
  for (const [key, item] of Object.entries(bib.entries)) {
    if (!("unexpected_fields" in item)) {
      record.bibtexAttachments[key] = false;
      continue;
    }

    if (typeof item.unexpected_fields?.file !== "string") {
      record.bibtexAttachments[key] = false;
      continue;
    }

    record.bibtexAttachments[key] = [item.unexpected_fields.file];
  }

  logger?.info(`BibLaTeX database loaded, ${Object.keys(record.cslData).length} items.`);

  // NOTE: The bib parser will encounter strange data and define them as errors.
  // HOWEVER this does NOT mean that the entries are invalid; just that some
  // input data is not as expected. We log them here.
  if (bib.errors.length > 0) {
    for (const error of bib.errors) {
      logger?.error(
        `BibLaTeX Parsing error on line ${error.line} (entry: ${error.entry}): ${error.type} (${error.value})`,
      );
    }
  }

  return record;
}
