import { md2html } from "@common/modules/markdown-utils/markdown-to-html";
import { reportError } from "@common/util/error-reporting";
import { setSanitizedHTML } from "@common/util/sanitize-html";
import { CITEPROC_MAIN_DB } from "@dts/common/citeproc";
import type { ReferenceDefinition } from "@dts/common/references";

type PreviewSource = Pick<ReferenceDefinition, "family" | "sourceKind" | "previewSource">;

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

/** Render the same bounded Markdown excerpt used by reference hovers. */
export function renderReferencePreview(
  target: HTMLElement,
  definition: PreviewSource,
  zknLinkFormat: "link|title" | "title|link",
): void {
  const source = referencePreviewMarkdown(definition);
  target.textContent = source;
  void md2html(source, {
    zknLinkFormat,
    onCitation: window.getCitationCallback(CITEPROC_MAIN_DB),
  })
    .then((html) => setSanitizedHTML(target, html, "document"))
    .catch((error) => reportError("Could not render the reference excerpt", error));
}
