/** Strict argv lexer for Just recipe arguments typed into the launcher. */

import { parse, type ParseEntry } from 'shell-quote'

function isGlob (entry: ParseEntry): entry is { op: 'glob', pattern: string } {
  return typeof entry === 'object' && 'op' in entry && entry.op === 'glob'
}

/**
 * Split one command-line argument string without executing shell syntax.
 * Quotes and backslash escapes work; globs and $VARS remain literal argv.
 */
export function parseJustArguments (input: string): string[] {
  const entries = parse(input, key => `$${key}`)
  const args: string[] = []
  for (const entry of entries) {
    if (typeof entry === 'string') {
      args.push(entry)
      continue
    }
    if (isGlob(entry)) {
      args.push(entry.pattern)
      continue
    }
    throw new Error('Enter recipe arguments only; shell operators and comments are not supported.')
  }
  return args
}
