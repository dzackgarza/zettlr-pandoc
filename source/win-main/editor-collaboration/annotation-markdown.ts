import { md2html } from "@common/modules/markdown-utils/markdown-to-html";
import { reportError } from "@common/util/error-reporting";
import { setSanitizedHTML } from "@common/util/sanitize-html";
import { CITEPROC_MAIN_DB } from "@dts/common/citeproc";
import type { Directive } from "vue";

async function renderAnnotationMarkdown(element: HTMLElement, source: string): Promise<void> {
  const html = await md2html(source, {
    zknLinkFormat: "link|title",
    onCitation: window.getCitationCallback(CITEPROC_MAIN_DB),
  });
  setSanitizedHTML(element, html, "document");
}

function render(element: HTMLElement, source: string): void {
  renderAnnotationMarkdown(element, source).catch((error) =>
    reportError("Could not render annotation Markdown", error),
  );
}

/** Render annotation-owned Markdown through the renderer's initialized MathJax pipeline. */
export const vAnnotationMarkdown: Directive<HTMLElement, string> = {
  mounted: (element, binding) => render(element, binding.value),
  updated: (element, binding) => {
    if (binding.value !== binding.oldValue) {
      render(element, binding.value);
    }
  },
};
