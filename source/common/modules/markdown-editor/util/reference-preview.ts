import { md2html } from "@common/modules/markdown-utils/markdown-to-html";
import { documentCitationDatabase } from "@common/util/document-citation-database";
import { reportError } from "@common/util/error-reporting";
import { imageSourceUri } from "@common/util/image-source-uri";
import { pathDirname } from "@common/util/renderer-path-polyfill";
import { setSanitizedHTML } from "@common/util/sanitize-html";
import type { ReferenceDefinition } from "@dts/common/references";

type PreviewSource = Pick<
  ReferenceDefinition,
  "family" | "sourceKind" | "previewSource" | "documentPath"
>;

/** The authored content of a reference target, without its label syntax. */
export function referencePreviewMarkdown(definition: PreviewSource): string {
  const lines = definition.previewSource.split("\n");

  if (definition.sourceKind === "theorem-div") {
    const last = lines[lines.length - 1].trim().startsWith(":::") ? -1 : undefined;
    return lines.slice(1, last).join("\n").trim();
  }

  if (definition.family === "lst") {
    const last = lines[lines.length - 1].trim().startsWith("```") ? -1 : undefined;
    return lines.slice(1, last).join("\n").trim();
  }

  if (definition.family === "tbl") {
    return definition.previewSource.replace(/\s*\{#tbl[:-][^}]+\}\s*$/u, "").trim();
  }

  const line = lines.join("\n");
  const brace = line.lastIndexOf("{");
  const clean = brace === -1 ? line : line.slice(0, brace);
  return clean
    .replace(/^#+\s*/, "")
    .replace(/^:\s*/, "")
    .trim();
}

/**
 * Render the same bounded Markdown excerpt used by reference hovers. Its
 * citations use the bibliography of the document that defines the target
 * (#198), and its images resolve from the folder of that document.
 */
export function renderReferencePreview(
  target: HTMLElement,
  definition: PreviewSource,
  zknLinkFormat: "link|title" | "title|link",
): void {
  const source = referencePreviewMarkdown(definition);
  target.textContent = source;
  documentCitationDatabase(definition.documentPath)
    .then(
      async (library) =>
        await md2html(source, {
          zknLinkFormat,
          onCitation: window.getCitationCallback(library),
          onImageSrc: (src) => imageSourceUri(src, pathDirname(definition.documentPath)),
        }),
    )
    .then((html) => setSanitizedHTML(target, html, "document"))
    .catch((error) => reportError("Could not render the reference excerpt", error));
}
