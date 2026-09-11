/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Status bar menus
 * CVM-Role:        Model
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The pure halves of the status bar's two popup menus: the
 *                  MagicQuotes pairs a language uses and the LanguageTool
 *                  language list. No DOM, no IPC.
 *
 * END HEADER
 */

import type { AnyMenuItem } from '@common/modules/window-register/application-menu-helper'
import { resolveLangCode } from '@common/util/map-lang-code'
import { trans } from '@common/i18n-renderer'

export interface QuotePair {
  primary: string
  secondary: string
}

/** The quote pair that means MagicQuotes is off: plain ASCII quotes. */
export const PLAIN_QUOTES: QuotePair = { primary: '"…"', secondary: "'…'" }

/**
 * All available MagicQuotes pairs (primary+secondary) as listed on Wikipedia:
 * https://de.wikipedia.org/wiki/Anf%C3%BChrungszeichen
 */
export const MAGIC_QUOTES_PAIRS: Record<string, QuotePair> = {
  af: { primary: '“…”', secondary: '‘…’' },
  ar: { primary: '«…»', secondary: '‹…›' },
  be: { primary: '«…»', secondary: '„…“' },
  bg: { primary: '„…“', secondary: '‚…‘' },
  ca: { primary: '«…»', secondary: '“…”' },
  cs: { primary: '„…“', secondary: '‚…‘' },
  da: { primary: '„…“', secondary: '‚…‘' },
  'de-CH': { primary: '«…»', secondary: '‹…›' },
  'de-DE': { primary: '„…“', secondary: '‚…‘' },
  el: { primary: '«…»', secondary: '“…”' },
  'en-GB': { primary: '‘…’', secondary: '“…”' },
  'en-US': { primary: '“…”', secondary: '‘…’' },
  eo: { primary: '“…”', secondary: "'…'" },
  es: { primary: '«…»', secondary: '“…”' },
  et: { primary: '„…”', secondary: '„…”' },
  eu: { primary: '«…»', secondary: '“…”' },
  'fi-FI': { primary: '”…”', secondary: '’…’' },
  'fr-FR': { primary: '« … »', secondary: '‹ … ›' },
  ga: { primary: '“…”', secondary: '‘…’' },
  he: { primary: '“…”', secondary: '«…»' },
  hr: { primary: '„…”', secondary: "'…'" },
  hu: { primary: '„…”', secondary: "'…'" },
  hy: { primary: '«…»', secondary: '„…“' },
  id: { primary: '”…”', secondary: '’…’' },
  is: { primary: '„…“', secondary: '‚…‘' },
  it: { primary: '«…»', secondary: "'…'" },
  'ja-JA': { primary: '「…」', secondary: '『…』' },
  ka: { primary: '„…“', secondary: "'…'" },
  ko: { primary: '“…”', secondary: '‘…’' },
  lt: { primary: '„…“', secondary: '‚…‘' },
  lv: { primary: '„…“', secondary: '‚…‘' },
  nl: { primary: '“…”', secondary: '‘…’' },
  no: { primary: '«…»', secondary: '‘…’' },
  pl: { primary: '„…”', secondary: "'…'" },
  'pt-BR': { primary: '“…”', secondary: '‘…’' },
  'pt-PT': { primary: '«…»', secondary: '“…”' },
  ro: { primary: '„…”', secondary: '«…»' },
  ru: { primary: '«…»', secondary: '„…“' },
  sk: { primary: '„…“', secondary: '‚…‘' },
  sl: { primary: '„…“', secondary: '‚…‘' },
  sq: { primary: '«…»', secondary: '‹…›' },
  sr: { primary: '„…”', secondary: '‚…’' },
  'sv-SV': { primary: '”…”', secondary: '’…’' },
  th: { primary: '“…”', secondary: '‘…’' },
  tr: { primary: '“…”', secondary: '‘…’' },
  uk: { primary: '«…»', secondary: '„…“' },
  wen: { primary: '„…“', secondary: '‚…‘' },
  'zh-CN': { primary: '“…”', secondary: '‘…’' },
  'zh-TW': { primary: '「…」', secondary: '『…』' }
}

/** A language's flag emoji, or the United Nations flag when none is known. */
function flagOf (code: string): string {
  const flag = resolveLangCode(code, 'flag')
  return flag === code ? '🇺🇳' : flag
}

/**
 * The MagicQuotes menu: off, custom (shown, never selectable), and every
 * language pair, with the pairs equal to the current one checked.
 */
export function magicQuotesMenuItems (current: QuotePair): AnyMenuItem[] {
  const disabled = current.primary === PLAIN_QUOTES.primary && current.secondary === PLAIN_QUOTES.secondary
  const matching = Object.entries(MAGIC_QUOTES_PAIRS)
    .filter(([ _key, pair ]) => pair.primary === current.primary && pair.secondary === current.secondary)
    .map(([ key ]) => key)
  const items: AnyMenuItem[] = [
    { type: 'checkbox', id: 'disabled', label: trans('Disabled'), checked: disabled },
    { type: 'checkbox', id: 'custom', label: trans('Custom'), enabled: false, checked: !disabled && matching.length === 0 },
    { type: 'separator' }
  ]
  for (const key of Object.keys(MAGIC_QUOTES_PAIRS)) {
    items.push({
      type: 'checkbox',
      id: key,
      label: `${flagOf(key)} ${resolveLangCode(key, 'name')}`,
      checked: matching.includes(key)
    })
  }
  return items
}

/** The quote pair a MagicQuotes menu choice stands for. */
export function magicQuotesPairFor (choice: string): QuotePair {
  if (choice === 'disabled') {
    return PLAIN_QUOTES
  }
  const pair = MAGIC_QUOTES_PAIRS[choice]
  if (pair === undefined) {
    throw new Error(`Unknown MagicQuotes choice: ${choice}`)
  }
  return pair
}

/**
 * The LanguageTool language menu: detect automatically, then every supported
 * language by its name, with a language code appended where two languages
 * share a name; the current override is checked.
 */
export function languageToolMenuItems (supportedLanguages: readonly string[], overrideLanguage: string, appLanguage: string): AnyMenuItem[] {
  const resolved = supportedLanguages.map(code => ({ code, displayName: resolveLangCode(code, 'name'), flag: flagOf(code) }))
  const collator = new Intl.Collator([ appLanguage, 'en' ], { sensitivity: 'base', usage: 'sort' })
  resolved.sort((a, b) => collator.compare(a.displayName, b.displayName))
  const items: AnyMenuItem[] = [
    { type: 'checkbox', id: 'auto', label: trans('Detect automatically'), checked: overrideLanguage === 'auto' },
    { type: 'separator' }
  ]
  for (const entry of resolved) {
    const duplicate = resolved.filter(other => other.displayName === entry.displayName).length > 1
    items.push({
      type: 'checkbox',
      id: entry.code,
      label: `${entry.flag} ${entry.displayName}${duplicate ? ` (${entry.code})` : ''}`,
      checked: overrideLanguage === entry.code
    })
  }
  return items
}
