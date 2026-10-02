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
import { renderTables } from "../table-editor";
import { configUpdateEffect, type EditorConfiguration } from "../util/configuration";
import { renderBlockquotes } from "./render-blockquotes";
import { renderCitations } from "./render-citations";
import { renderCode } from "./render-code";
import { renderEmphasis } from "./render-emphasis";
import { renderHeadings } from "./render-headings";
import { renderHorizontalRules } from "./render-hr";
import { renderIframes } from "./render-iframes";
import { renderImages } from "./render-images";
import { renderLinks } from "./render-links";
import { renderMath } from "./render-math";
import { renderMermaid } from "./render-mermaid";
import { renderPandocAttributes } from "./render-pandoc-attributes";
import { renderPandoc } from "./render-pandoc-div-span";
import { renderReferenceChips } from "./render-reference-chips";
import { renderReferenceDefinitions } from "./render-reference-definitions";
import { renderTasks } from "./render-tasks";
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
function configureRenderers(config: EditorConfiguration, ext?: Extension[]) {
  if (ext === undefined || config.renderingMode === "raw") {
    // Default extensions to always include
    ext = [renderCode];
  }

  if (config.renderingMode === "preview") {
    updateExtension(renderYamlFrontmatter, true, ext);
    updateExtension(renderMermaid, true, ext);
    updateExtension(renderTikzFigures, true, ext);
    updateExtension(renderCode, true, ext);
    updateExtension(renderImages, config.renderImages, ext);
    updateExtension(renderLinks, config.renderLinks, ext);
    updateExtension(renderWikilinks, config.renderLinks, ext);
    updateExtension(renderMath, config.renderMath, ext);
    updateExtension(renderTasks, config.renderTasks, ext);
    updateExtension(renderHeadings, config.renderHeadings, ext);
    updateExtension(renderCitations, config.renderCitations, ext);
    // The reference chips and definition badges (issue #1 Phase 4) follow the
    // citation-rendering toggle: they present the same `@`-cluster surface.
    updateExtension(renderReferenceChips, config.renderCitations, ext);
    updateExtension(renderReferenceDefinitions, config.renderCitations, ext);
    updateExtension(renderTables, config.renderTables, ext);
    updateExtension(renderIframes, config.renderIframes, ext);
    updateExtension(renderEmphasis, config.renderEmphasis, ext);
    updateExtension(renderBlockquotes, config.renderEmphasis, ext);
    updateExtension(renderPandoc, config.renderPandoc, ext);
    // Attribute blocks on non-div carriers (headings, captions, images…)
    // follow the same toggle as the div/span renderer: both present Pandoc
    // attribute machinery.
    updateExtension(renderPandocAttributes, config.renderPandoc, ext);
    updateExtension(renderHorizontalRules, config.renderHorizontalRules, ext);
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
      const next = configureRenderers(
        effect.value,
        current === undefined ? undefined : [...current],
      );
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
