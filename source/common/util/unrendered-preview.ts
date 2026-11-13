/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        unrenderedPreviewHtml
 * CVM-Role:        Utility Function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The markup of a preview that md2html could not render.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";

/**
 * The markup of a preview of Markdown that md2html could not render (a
 * citation while the citation style does not load): the source text and the
 * cause. A preview shows this in place of its rendered text, so the author
 * reads the text and the reason that it is not rendered (#92).
 */
export function unrenderedPreviewHtml(source: string, failure: Error): string {
  const wrapper = document.createElement("div");
  const text = document.createElement("p");
  text.classList.add("preview-source");
  text.textContent = source;
  const cause = document.createElement("p");
  cause.classList.add("preview-failure");
  cause.textContent = trans("This preview could not be rendered: %s", failure.message);
  wrapper.append(text, cause);
  return wrapper.innerHTML;
}
