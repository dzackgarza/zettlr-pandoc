import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

export const PANDOC_REFERENCE_VERSION = '3.10.2'
export const PANDOC_REFERENCE_COMMIT = 'f2ee5dfee866aab007a33552acc6bc01810c6918'

const CI_REFERENCE_BIN = '/usr/local/bin/pandoc-reference'

function referenceBinary (): string {
  const configured = process.env.PANDOC_REFERENCE_BIN
  if (configured !== undefined && configured.trim() !== '') {
    return configured
  }
  if (existsSync(CI_REFERENCE_BIN)) {
    return CI_REFERENCE_BIN
  }
  return 'pandoc'
}

let verifiedBinary: string|undefined

/**
 * Resolve and verify the executable oracle for the vendored Pandoc grammar.
 *
 * Parser differential tests are claims about one pinned Pandoc implementation,
 * not about whichever Pandoc happens to be on PATH. A version mismatch is
 * therefore a failed test precondition, never an alternate oracle.
 */
export function pandocReferenceBinary (): string {
  const binary = referenceBinary()
  if (verifiedBinary === binary) {
    return binary
  }

  const version = execFileSync(binary, [ '--version' ], { encoding: 'utf8' })
    .split(/\r?\n/u, 1)[0]
    .trim()
  const expected = 'pandoc ' + PANDOC_REFERENCE_VERSION
  if (version !== expected) {
    throw new Error(
      'Pandoc grammar oracle mismatch: expected ' + expected +
      ' (' + PANDOC_REFERENCE_COMMIT + '), got ' + JSON.stringify(version) +
      ' from ' + binary + '. Set PANDOC_REFERENCE_BIN to the exact reference executable.'
    )
  }

  verifiedBinary = binary
  return binary
}

export interface PandocReferenceExecOptions {
  input?: string
  maxBuffer?: number
}

/** Execute the exact Pandoc reference reader and return UTF-8 stdout. */
export function execPandocReference (
  args: string[],
  options: PandocReferenceExecOptions = {}
): string {
  return execFileSync(pandocReferenceBinary(), args, {
    ...options,
    encoding: 'utf8'
  })
}
