/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Attachment icon markup tests
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Proves that file-extension labels remain text when the
 *                  bundled attachment SVG crosses the v-html boundary.
 *
 * END HEADER
 */

import assert from "assert";
import "mocha";
import { getAttachmentIconMarkup } from "source/win-main/sidebar/attachment-icon-markup";

function renderIconMarkup(extension: string): SVGElement {
  const host = document.createElement("div");
  host.innerHTML = getAttachmentIconMarkup(extension);
  const svg = host.querySelector("svg");
  assert(svg !== null, "attachment icon markup must contain its bundled SVG root");
  return svg;
}

function extensionLabel(svg: SVGElement): SVGElement {
  const label = svg.querySelector("tspan");
  assert(label !== null, "attachment icon SVG must contain its extension text label");
  return label;
}

describe("attachment icon markup", function () {
  it("renders an ordinary three-character extension in the bundled SVG label", function () {
    const svg = renderIconMarkup(".pdf");

    assert.strictEqual(extensionLabel(svg).textContent, "pdf");
  });

  it("renders a markup-shaped three-character extension only as text", function () {
    const host = document.createElement("div");
    host.innerHTML = getAttachmentIconMarkup(".<i>");
    const svg = host.querySelector("svg");
    assert(svg !== null, "attachment icon markup must contain its bundled SVG root");

    assert.strictEqual(
      host.querySelector("i"),
      null,
      "the extension must not introduce an element",
    );
    assert.strictEqual(extensionLabel(svg).textContent, "<i>");
  });
});
