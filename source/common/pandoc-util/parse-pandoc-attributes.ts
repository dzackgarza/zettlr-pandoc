import { scanPandocAttributeList } from './pandoc-attribute-syntax'

/**
 * Represents a parsed Pandoc LinkAttributes string (e.g., `{width=50%}`).
 */
export interface ParsedPandocAttributes {
  /**
   * The ID, if present (`#id`)
   */
  id?: string
  /**
   * Any classes found in the string (e.g., `.class`)
   */
  classes?: string[]
  /**
   * Any additional properties. NOTE: This parser does not, unlike Pandoc's
   * parser, distinguish between HTML5 properties and custom-properties.
   */
  properties?: Record<string, string>
}

/**
 * Formats a `PandocAttributes` object into a useable HTML string.
 *
 * @param attributes
 */
export function formatPandocAttributes (attributes: ParsedPandocAttributes): string {
  const parts: string[] = []

  if (attributes.id !== undefined) {
    parts.push('#' + attributes.id)
  }

  if (attributes.classes !== undefined) {
    parts.push(attributes.classes.map(v => '.' + v).join(' '))
  }

  if (attributes.properties !== undefined) {
    const properties = Object.entries(attributes.properties)
      .map(([ key, value ]) => {
        if (value !== undefined) {
          return (`${key}="${value}"`)
        }

        return key
      })
      .join(' ')

    parts.push(properties)
  }

  return parts.join(' ')
}

/**
 * Parses a Pandoc link attribute string, as defined in
 * https://pandoc.org/MANUAL.html#extension-link_attributes.
 *
 * @param   {string}  attrString  The attribute string (e.g., `{width=50%}`)
 *
 * @return  {ParsedPandocAttributes}  The parsed string
 */
export function parsePandocAttributes (attrString: string): ParsedPandocAttributes {
  const trimmed = attrString.trim()
  const source = trimmed.startsWith('{') ? trimmed : `{${trimmed}}`
  const scanned = scanPandocAttributeList(source)
  if (scanned.status !== 'match' || scanned.value.to !== source.length) {
    return {}
  }

  const parsed: ParsedPandocAttributes = {}
  for (const token of scanned.value.tokens) {
    if (token.kind === 'id') {
      parsed.id = token.value
      continue
    }
    if (token.kind === 'class' || token.kind === 'special') {
      parsed.classes ??= []
      parsed.classes.push(token.value)
      continue
    }

    const key = token.key
    let value = token.value
    if (key === 'id') {
      parsed.id = value
      continue
    }
    if (key === 'class') {
      parsed.classes ??= []
      parsed.classes.push(...value.split(/\s+/).filter(Boolean))
      continue
    }
    if ((key.toLowerCase() === 'width' || key.toLowerCase() === 'height') && /^\d+$/.test(value)) {
      value += 'px'
    }
    parsed.properties ??= {}
    parsed.properties[key] = value
  }
  return parsed
}
