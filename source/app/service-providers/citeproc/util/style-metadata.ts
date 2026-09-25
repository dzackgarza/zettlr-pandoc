/**
 * CSL style metadata needed to choose a semantically valid citation request.
 *
 * Narrative Pandoc citations (`@key`) are not universally author-in-text:
 * label/numeric/note CSL styles have no author-only citation form. The CSL
 * category metadata is the source of truth; citeproc's internal `bib_mode`
 * number is deliberately not used here.
 */

import { DOMParser } from '@xmldom/xmldom'

export type CslCitationFormat = 'author'|'author-date'|'label'|'numeric'|'note'

export interface CslStyleMetadata {
  citationFormat?: CslCitationFormat
}

const CITATION_FORMATS = new Set<CslCitationFormat>([
  'author',
  'author-date',
  'label',
  'numeric',
  'note',
])

export function parseCslStyleMetadata (source: string): CslStyleMetadata {
  const document = new DOMParser({
    onError: (level, message) => {
      if (level !== 'warning') {
        throw new Error(`Invalid CSL XML: ${message}`)
      }
    },
  }).parseFromString(source, 'application/xml')

  const formats = new Set<string>()
  for (const category of Array.from(document.getElementsByTagName('category'))) {
    const value = category.getAttribute('citation-format')
    if (value !== null && value !== '') {
      formats.add(value)
    }
  }

  if (formats.size > 1) {
    throw new Error(`CSL style declares conflicting citation-format categories: ${[...formats].join(', ')}`)
  }
  const [format] = formats
  if (format === undefined) {
    return {}
  }
  if (!CITATION_FORMATS.has(format as CslCitationFormat)) {
    throw new Error(`CSL style declares unsupported citation-format=${JSON.stringify(format)}`)
  }
  return { citationFormat: format as CslCitationFormat }
}

/** Whether citeproc's author-only + suppress-author composite mode is meaningful. */
export function supportsNarrativeComposite (format: CslCitationFormat|undefined): boolean {
  // Missing metadata is not silently reclassified. We attempt the CSL-native
  // composite request and let throw_on_empty reject styles that cannot supply
  // it. Known non-narrative formats never receive an incoherent author-only
  // request in the first place.
  return format === undefined || format === 'author' || format === 'author-date'
}
