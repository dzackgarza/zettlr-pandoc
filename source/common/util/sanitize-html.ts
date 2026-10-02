/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        sanitizeHTML, sanitizedFragment, setSanitizedHTML
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     The one sink for app-generated markup: DOMPurify with the
 *                  configuration each kind of markup needs.
 *
 * END HEADER
 */
import DOMPurify, { type Config, type DOMPurify as Purifier } from "dompurify";

/**
 * The kinds of markup the app produces and inserts into the DOM.
 *
 * - `document`: md2html output, citeproc citations and bibliographies, and the
 *   MathJax CHTML inside them (`mjx-*` custom elements, MathML).
 * - `graphic`: SVG figures: Mermaid charts (HTML labels in `<foreignObject>`),
 *   pdf2svg TikZ figures (glyphs drawn with `<use xlink:href="#…">`) and icon
 *   SVG files.
 */
export type MarkupKind = "document" | "graphic";

const CONFIGS: Record<MarkupKind, Config> = {
  document: {
    // Markdown links and images carry app protocols (safe-file:, zettlr:)
    // and any scheme the user wrote; script and data URIs stay forbidden.
    ALLOW_UNKNOWN_PROTOCOLS: true,
    CUSTOM_ELEMENT_HANDLING: {
      tagNameCheck: /^mjx-/,
      // MathJax CHTML attributes (jax, size, justify, …); no event handlers.
      attributeNameCheck: /^(?!on)[a-z][a-z0-9_-]*$/,
      allowCustomizedBuiltInElements: false,
    },
  },
  // Mermaid's own DOMPurify configuration (mermaid.core.mjs, serializeSvg),
  // plus `use` for the pdf2svg glyph references.
  graphic: {
    ADD_TAGS: ["foreignobject", "use"],
    ADD_ATTR: ["dominant-baseline"],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
  },
};

const purifiers = new Map<MarkupKind, Purifier>();

function purifier(kind: MarkupKind): Purifier {
  const existing = purifiers.get(kind);
  if (existing !== undefined) {
    return existing;
  }

  const created = DOMPurify(window);
  if (!created.isSupported) {
    throw new Error("DOMPurify cannot sanitize in this environment: the window has no usable DOM.");
  }
  if (kind === "graphic") {
    // `<use>` may reference only an element of the same document, never an
    // external or data: resource.
    created.addHook("uponSanitizeAttribute", (node, data) => {
      const isReference = data.attrName === "href" || data.attrName === "xlink:href";
      if (node.nodeName.toLowerCase() === "use" && isReference && !data.attrValue.startsWith("#")) {
        data.keepAttr = false;
      }
    });
  }
  purifiers.set(kind, created);
  return created;
}

/**
 * Sanitizes app-generated markup of the given kind into DOM nodes.
 *
 * @param   {string}            html  The markup
 * @param   {MarkupKind}        kind  What produced the markup
 *
 * @return  {DocumentFragment}        The sanitized nodes
 */
export function sanitizedFragment(html: string, kind: MarkupKind): DocumentFragment {
  return purifier(kind).sanitize(html, { ...CONFIGS[kind], RETURN_DOM_FRAGMENT: true });
}

/**
 * Replaces the children of `element` with the sanitized markup.
 *
 * @param   {Element}     element  The target element
 * @param   {string}      html     The markup
 * @param   {MarkupKind}  kind     What produced the markup
 */
export function setSanitizedHTML(element: Element, html: string, kind: MarkupKind): void {
  element.replaceChildren(sanitizedFragment(html, kind));
}

/**
 * Sanitizes the provided HTML string and prepare it for insertion into the DOM.
 * This function uses DOMPurify, but configures it so that it works for the
 * context of Zettlr.
 *
 * @param   {string}  html  The dirty HTML
 *
 * @return  {string}        The cleaned HTML
 */
export function sanitizeHTML(html: string) {
  return DOMPurify.sanitize(html, {
    // Allow tags that Zettlr uses
    ADD_TAGS: ["cds-icon"],
  });
}
