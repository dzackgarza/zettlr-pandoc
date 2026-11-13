import { md2html } from "@common/modules/markdown-utils/markdown-to-html";
import { documentCitationDatabase } from "@common/util/document-citation-database";
import { reportError } from "@common/util/error-reporting";
import { setSanitizedHTML } from "@common/util/sanitize-html";
import { unrenderedPreviewHtml } from "@common/util/unrendered-preview";
import type { Directive } from "vue";

/** Annotation Markdown and the document whose citations it uses (#198). */
export interface AnnotationMarkdown {
  text: string;
  documentPath: string;
}

async function renderAnnotationMarkdown({
  text,
  documentPath,
}: AnnotationMarkdown): Promise<string> {
  const library = await documentCitationDatabase(documentPath);
  return await md2html(text, {
    zknLinkFormat: "link|title",
    onCitation: window.getCitationCallback(library),
  });
}

function render(element: HTMLElement, value: AnnotationMarkdown): void {
  renderAnnotationMarkdown(value).then(
    (html) => setSanitizedHTML(element, html, "document"),
    (failure: Error) => {
      reportError("Could not render annotation Markdown", failure);
      setSanitizedHTML(element, unrenderedPreviewHtml(value.text, failure), "document");
    },
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
