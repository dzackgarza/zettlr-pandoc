/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Renderer Entry Point
 * CVM-Role:        Extension
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This module defines an extension that provides configurable
 *                  renderers for Markdown files.
 *
 * END HEADER
 */

import { Compartment, EditorState, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { markdownRenderers } from "@dzack/pandoc-editor";
import { renderMath } from "@dzack/pandoc-editor/renderers/render-math";
import { renderTables } from "../table-editor";
import { configUpdateEffect, type EditorConfiguration } from "../util/configuration";
import { renderCitations } from "./render-citations";
import { renderIframes } from "./render-iframes";
import { renderImages } from "./render-images";
import { renderMermaid } from "./render-mermaid";
import { renderPandocAttributes } from "./render-pandoc-attributes";
import { renderPandoc } from "./render-pandoc-div-span";
import { renderReferenceChips } from "./render-reference-chips";
import { renderReferenceDefinitions } from "./render-reference-definitions";
import { renderTikzFigures } from "./render-tikz";
import { renderWikilinks } from "./render-wikilinks";
import { renderYamlFrontmatter } from "./render-yaml-frontmatter";

const renderCompartment = new Compartment();

/* Adds or removes an extension from a list of extensions based on the value of enabled */
function updateExtension(renderer: Extension, enabled: boolean, ext: Extension[]) {
  const idx = ext.indexOf(renderer);

  // Renderer is enabled and not in the list
  if (enabled === true && idx === -1) {
    ext.push(renderer);
  }
  // Renderer is disabled and in the list
  if (enabled === false && idx > -1) {
    ext.splice(idx, 1);
  }

  return ext;
}

/* Configures the enabled renderer extensions, optionally updating an existing set of extensions */
function configureRenderers(config: EditorConfiguration) {
  const ext = markdownRenderers(config);

  if (config.renderingMode === "preview") {
    updateExtension(renderYamlFrontmatter, true, ext);
    updateExtension(renderMermaid, true, ext);
    updateExtension(renderTikzFigures, true, ext);
    updateExtension(renderImages, config.renderImages, ext);
    updateExtension(renderWikilinks, config.renderLinks, ext);
    updateExtension(renderMath, config.renderMath, ext);
    updateExtension(renderCitations, config.renderCitations, ext);
    // The reference chips and definition badges (issue #1 Phase 4) follow the
    // citation-rendering toggle: they present the same `@`-cluster surface.
    updateExtension(renderReferenceChips, config.renderCitations, ext);
    updateExtension(renderReferenceDefinitions, config.renderCitations, ext);
    updateExtension(renderTables, config.renderTables, ext);
    updateExtension(renderIframes, config.renderIframes, ext);
    updateExtension(renderPandoc, config.renderPandoc, ext);
    // Attribute blocks on non-div carriers (headings, captions, images…)
    // follow the same toggle as the div/span renderer: both present Pandoc
    // attribute machinery.
    updateExtension(renderPandocAttributes, config.renderPandoc, ext);
  }

  return ext;
}

/**
 * A TransactionExtender that reconfigures the renderer extension compartment in response
 * to a configUpdateEffect
 */
const modeSwitcher = EditorState.transactionExtender.of((transaction) => {
  for (const effect of transaction.effects) {
    if (effect.is(configUpdateEffect)) {
      // A reconfiguration makes the view draw its content again, so only a
      // changed set of renderers causes one.
      const current = renderCompartment.get(transaction.startState) as Extension[] | undefined;
      const next = configureRenderers(effect.value);
      if (
        current !== undefined &&
        next.length === current.length &&
        next.every((renderer, i) => renderer === current[i])
      ) {
        return null;
      }
      return { effects: renderCompartment.reconfigure(next) };
    }
  }

  return null;
});

/**
 * Configures the renderers that are active in the given Markdown state.
 *
 * @param   {EditorConfiguration}  config  An optional initial config
 *
 * @return  {Extension}                             The extension set
 */
export function renderers(config: EditorConfiguration): Extension {
  return [modeSwitcher, renderCompartment.of(configureRenderers(config))];
}
