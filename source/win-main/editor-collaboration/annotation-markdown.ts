import { markdownFragmentToHTML } from "@common/modules/markdown-utils/markdown-to-html";
import { setSanitizedHTML } from "@common/util/sanitize-html";
import { CITEPROC_MAIN_DB } from "@dts/common/citeproc";
import type { Directive } from "vue";

function renderAnnotationMarkdown(element: HTMLElement, source: string): void {
  const html = markdownFragmentToHTML(source, {
    zknLinkFormat: "link|title",
    onCitation: window.getCitationCallback(CITEPROC_MAIN_DB),
  });
  setSanitizedHTML(element, html, "document");
}

/** Render annotation-owned Markdown through the renderer's initialized MathJax pipeline. */
export const vAnnotationMarkdown: Directive<HTMLElement, string> = {
  mounted: (element, binding) => renderAnnotationMarkdown(element, binding.value),
  updated: (element, binding) => {
    if (binding.value !== binding.oldValue) {
      renderAnnotationMarkdown(element, binding.value);
    }
  },
};
