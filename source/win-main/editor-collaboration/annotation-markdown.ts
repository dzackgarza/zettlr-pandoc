import { md2html } from "@common/modules/markdown-utils/markdown-to-html";
import { documentCitationDatabase } from "@common/util/document-citation-database";
import { reportError } from "@common/util/error-reporting";
import { setSanitizedHTML } from "@common/util/sanitize-html";
import type { Directive } from "vue";

/** Annotation Markdown and the document whose citations it uses (#198). */
export interface AnnotationMarkdown {
  text: string;
  documentPath: string;
}

async function renderAnnotationMarkdown(
  element: HTMLElement,
  { text, documentPath }: AnnotationMarkdown,
): Promise<void> {
  const library = await documentCitationDatabase(documentPath);
  const html = await md2html(text, {
    zknLinkFormat: "link|title",
    onCitation: window.getCitationCallback(library),
  });
  setSanitizedHTML(element, html, "document");
}

function render(element: HTMLElement, value: AnnotationMarkdown): void {
  renderAnnotationMarkdown(element, value).catch((error) =>
    reportError("Could not render annotation Markdown", error),
  );
}

/** Render annotation-owned Markdown through the renderer's initialized MathJax pipeline. */
export const vAnnotationMarkdown: Directive<HTMLElement, AnnotationMarkdown> = {
  mounted: (element, binding) => render(element, binding.value),
  updated: (element, binding) => {
    const old = binding.oldValue;
    if (
      old === null ||
      old === undefined ||
      binding.value.text !== old.text ||
      binding.value.documentPath !== old.documentPath
    ) {
      render(element, binding.value);
    }
  },
};
