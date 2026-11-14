/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Replace Links
 * CVM-Role:        Utility
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Computes the rewrites that retarget the wikilinks, the
 *                  Markdown links and the images of a file after a file or a
 *                  directory moved
 *
 * END HEADER
 */

import path from "path";
import { unescape } from "querystring";
import { extractASTNodes, markdownToAST, type WikilinkFormat } from "../modules/markdown-utils";
import { type LinkOrImage, type ZettelkastenLink } from "../modules/markdown-utils/markdown-ast";
import { type WikilinkIndex } from "./wikilink-resolution";
import { splitWikilinkTarget } from "./wikilink-target";

/** One rewritten link target: the range of the old target and its new text. */
export interface LinkReplacement {
  from: number;
  to: number;
  text: string;
}

/**
 * The rewrites of the wikilink targets in a Markdown document. `rewrite`
 * receives each link's target, before its `#` fragment, and returns the new
 * target, or undefined to leave the link as it is. The fragment and the label
 * are kept.
 *
 * @param   {string}          markdown    The document in question.
 * @param   {WikilinkFormat}  linkFormat  How a wikilink names its document
 * @param   {Function}        rewrite     The new target for a link target
 *
 * @return  {LinkReplacement[]}  The replacements, in document order
 */
function linkReplacements(
  markdown: string,
  linkFormat: WikilinkFormat,
  rewrite: (target: string) => string | undefined,
): LinkReplacement[] {
  const ast = markdownToAST(markdown, null, linkFormat);
  const links = extractASTNodes(ast, "ZettelkastenLink") as ZettelkastenLink[];

  const replacements: LinkReplacement[] = [];
  for (const link of links) {
    const { target, fragment } = splitWikilinkTarget(link.target);
    const replacement = rewrite(target);
    if (replacement === undefined) {
      continue;
    }
    replacements.push({
      ...link.targetRange,
      text: fragment === undefined ? replacement : `${replacement}#${fragment}`,
    });
  }
  return replacements.sort((a, b) => a.from - b.from);
}

/** A file or a directory that moved from `from` to `to`. */
export interface PathMove {
  from: string;
  to: string;
}

/** Where `filePath` is after `move`: moved with it, or where it was. */
export function movedPath(filePath: string, move: PathMove): string {
  if (filePath === move.from) {
    return move.to;
  }
  if (filePath.startsWith(move.from + path.sep)) {
    return move.to + filePath.slice(move.from.length);
  }
  return filePath;
}

/**
 * The new target of the wikilink `target` in the document that was at
 * `sourcePath` before `move`, or undefined when the link names the same
 * document on both sides of the move. `before` and `after` index the
 * workspace on either side. A link whose document the move changed (a
 * relative path into or out of a moved directory, a name the move made
 * ambiguous or gave to another document) takes the written form of the
 * document it named before.
 */
export function retargetedLink(
  target: string,
  sourcePath: string,
  move: PathMove,
  before: WikilinkIndex,
  after: WikilinkIndex,
): string | undefined {
  const previous = before.resolve(target, sourcePath);
  if (previous.status !== "resolved") {
    return undefined;
  }
  const destination = movedPath(previous.path, move);
  const current = after.resolve(target, movedPath(sourcePath, move));
  return current.status === "resolved" && current.path === destination
    ? undefined
    : after.canonical(destination);
}

/** A URL with a scheme (RFC 3986, section 3.1) names no file of the workspace. */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** The URL of a Markdown link or image, as written, read as a path. */
interface WrittenLinkUrl {
  /** The URL is written in angle brackets. */
  bracketed: boolean;
  /** The path is written with percent-encoding. */
  encoded: boolean;
  /** The path as written, before its query and fragment. */
  written: string;
  /** The path that the written path names. */
  path: string;
  /** The query and the fragment, as written. */
  suffix: string;
}

function readLinkUrl(source: string): WrittenLinkUrl {
  const bracketed = source.startsWith("<") && source.endsWith(">");
  const url = bracketed ? source.slice(1, -1) : source;
  const cut = url.search(/[?#]/);
  const written = cut === -1 ? url : url.slice(0, cut);
  const encoded = /%[0-9A-Fa-f]{2}/.test(written);
  return {
    bracketed,
    encoded,
    written,
    // `querystring.unescape` decodes each valid escape and leaves a
    // malformed one as written; it does not throw.
    path: encoded ? unescape(written) : written,
    suffix: cut === -1 ? "" : url.slice(cut),
  };
}

/**
 * Whether the URL of a Markdown link or image, as written, can name a file:
 * it has no scheme and is more than a fragment of its own document.
 */
export function isFileLinkUrl(source: string): boolean {
  const url = readLinkUrl(source);
  return url.path !== "" && !SCHEME.test(url.path);
}

/**
 * The new URL of the Markdown link or image `source` (the URL as written) in
 * the document that was at `sourcePath` before `move`, or undefined when the
 * URL names the same file on both sides of the move. A relative URL stays
 * relative to its document and keeps its `./`; an absolute one stays
 * absolute. The query, the fragment, the angle brackets and the
 * percent-encoding are kept. A URL is changed only when the file it named is
 * at its new place (`exists`), so a URL that names no file stays as written.
 */
export function retargetedFileLink(
  source: string,
  sourcePath: string,
  move: PathMove,
  exists: (filePath: string) => boolean,
): string | undefined {
  if (!isFileLinkUrl(source)) {
    return undefined;
  }
  const url = readLinkUrl(source);
  const absolute = path.isAbsolute(url.path);
  const sourceDirectory = path.dirname(movedPath(sourcePath, move));
  const destination = movedPath(
    absolute ? url.path : path.resolve(path.dirname(sourcePath), url.path),
    move,
  );
  const current = absolute ? url.path : path.resolve(sourceDirectory, url.path);
  if (path.resolve(current) === destination || !exists(destination)) {
    return undefined;
  }

  let written = absolute
    ? destination
    : path.relative(sourceDirectory, destination).split(path.sep).join("/");
  if (!absolute && url.written.startsWith("./") && !written.startsWith("../")) {
    written = `./${written}`;
  }
  if (url.path.endsWith("/")) {
    written = `${written}/`;
  }
  const text = (url.encoded ? encodeURI(written) : written) + url.suffix;
  return url.bracketed || (!url.encoded && /\s/.test(text)) ? `<${text}>` : text;
}

/** The Markdown links and images of a parsed document. */
function fileLinksOf(markdown: string, linkFormat: WikilinkFormat): LinkOrImage[] {
  const ast = markdownToAST(markdown, null, linkFormat);
  return [
    ...(extractASTNodes(ast, "Link") as LinkOrImage[]),
    ...(extractASTNodes(ast, "Image") as LinkOrImage[]),
  ];
}

/**
 * The URLs, as written, of the Markdown links and images of `markdown` that
 * can name a file (see `isFileLinkUrl`).
 */
export function fileLinkUrls(markdown: string, linkFormat: WikilinkFormat): string[] {
  return fileLinksOf(markdown, linkFormat)
    .map((link) => markdown.slice(link.urlRange.from, link.urlRange.to))
    .filter(isFileLinkUrl);
}

/**
 * The replacements that retarget the links in `markdown`, the text of the
 * document that was at `sourcePath` before `move`, read with the link format
 * `linkFormat`: each wikilink (see `retargetedLink`) and each Markdown link
 * and image (see `retargetedFileLink`).
 */
export function retargetLinks(
  markdown: string,
  sourcePath: string,
  move: PathMove,
  before: WikilinkIndex,
  after: WikilinkIndex,
  linkFormat: WikilinkFormat,
  exists: (filePath: string) => boolean,
): LinkReplacement[] {
  const wikilinks = linkReplacements(markdown, linkFormat, (target) =>
    retargetedLink(target, sourcePath, move, before, after),
  );
  const fileLinks = fileLinksOf(markdown, linkFormat).flatMap(({ urlRange }) => {
    const text = retargetedFileLink(
      markdown.slice(urlRange.from, urlRange.to),
      sourcePath,
      move,
      exists,
    );
    return text === undefined ? [] : [{ ...urlRange, text }];
  });
  return [...wikilinks, ...fileLinks].sort((a, b) => a.from - b.from);
}
