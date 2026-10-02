import { type PandocAttributeToken, scanPandocAttributeList } from "@lezer/markdown";

/**
 * A scanned token that sets the element identifier: `#id` or `id=…`.
 */
export type PandocIdentifierToken =
  | Extract<PandocAttributeToken, { kind: "id" }>
  | (Extract<PandocAttributeToken, { kind: "key-value" }> & { key: "id" });

/**
 * Represents a parsed Pandoc LinkAttributes string (e.g., `{width=50%}`).
 */
export interface ParsedPandocAttributes {
  /**
   * The ID, if present (`#id`)
   */
  id?: string;
  /**
   * Any classes found in the string (e.g., `.class`)
   */
  classes?: string[];
  /**
   * Any additional properties. NOTE: This parser does not, unlike Pandoc's
   * parser, distinguish between HTML5 properties and custom-properties.
   */
  properties?: Record<string, string>;
}

/**
 * Formats a `PandocAttributes` object into a useable HTML string.
 *
 * @param attributes
 */
export function formatPandocAttributes(attributes: ParsedPandocAttributes): string {
  const parts: string[] = [];

  if (attributes.id !== undefined) {
    parts.push("#" + attributes.id);
  }

  if (attributes.classes !== undefined) {
    parts.push(attributes.classes.map((v) => "." + v).join(" "));
  }

  if (attributes.properties !== undefined) {
    const properties = Object.entries(attributes.properties)
      .map(([key, value]) => {
        if (value !== undefined) {
          return `${key}="${value}"`;
        }

        return key;
      })
      .join(" ");

    parts.push(properties);
  }

  return parts.join(" ");
}

/**
 * Parses a Pandoc link attribute string, as defined in
 * https://pandoc.org/MANUAL.html#extension-link_attributes.
 *
 * @param   {string}  attrString  The attribute string (e.g., `{width=50%}`)
 *
 * @return  {ParsedPandocAttributes}  The parsed string
 */
export function parsePandocAttributes(attrString: string): ParsedPandocAttributes {
  const trimmed = attrString.trim();
  const source = trimmed.startsWith("{") ? trimmed : `{${trimmed}}`;
  const scanned = scanPandocAttributeList(source);
  if (scanned.status !== "match" || scanned.value.to !== source.length) {
    return {};
  }

  return pandocAttributesFromTokens(scanned.value.tokens);
}

/**
 * Whether a scanned token sets the element identifier. Pandoc's `keyValAttr`
 * reads `id="…"` as the identifier, exactly like `identifierAttr` reads `#…`.
 *
 * @param   {PandocAttributeToken}  token  The scanned token
 *
 * @return  {boolean}                      True for `#id` and `id=…`
 */
export function isPandocIdentifierToken(
  token: PandocAttributeToken,
): token is PandocIdentifierToken {
  return token.kind === "id" || (token.kind === "key-value" && token.key === "id");
}

/**
 * The classes of one attribute list in source order: `.class` and special
 * tokens, and each word of a `class="…"` value. A list without classes has
 * none.
 *
 * @param   {PandocAttributeToken[]}  tokens  The tokens of one attribute list
 *
 * @return  {string[]}                        The classes
 */
export function pandocClassesFromTokens(tokens: readonly PandocAttributeToken[]): string[] {
  const classes: string[] = [];
  for (const token of tokens) {
    if (token.kind === "class" || token.kind === "special") {
      classes.push(token.value);
    } else if (token.kind === "key-value" && token.key === "class") {
      classes.push(...token.value.split(/\s+/).filter(Boolean));
    }
  }
  return classes;
}

/**
 * Folds the scanned tokens of one attribute list into its parsed attributes.
 * A later identifier replaces an earlier one, as in Pandoc.
 *
 * @param   {PandocAttributeToken[]}  tokens  The tokens of one attribute list
 *
 * @return  {ParsedPandocAttributes}          The parsed attributes
 */
export function pandocAttributesFromTokens(
  tokens: readonly PandocAttributeToken[],
): ParsedPandocAttributes {
  const parsed: ParsedPandocAttributes = {};
  const classes = pandocClassesFromTokens(tokens);
  if (classes.length > 0) {
    parsed.classes = classes;
  }
  for (const token of tokens) {
    if (isPandocIdentifierToken(token)) {
      parsed.id = token.value;
      continue;
    }
    if (token.kind === "class" || token.kind === "special") {
      continue;
    }

    const key = token.key;
    let value = token.value;
    if (key === "class") {
      continue;
    }
    if ((key.toLowerCase() === "width" || key.toLowerCase() === "height") && /^\d+$/.test(value)) {
      value += "px";
    }
    parsed.properties ??= {};
    parsed.properties[key] = value;
  }
  return parsed;
}
