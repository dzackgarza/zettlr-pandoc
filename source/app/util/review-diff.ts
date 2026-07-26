import fs from 'fs'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { applyPatch, parsePatch, type StructuredPatch } from 'diff'
import { hasMdOrCodeExt } from '@common/util/file-extention-checks'
import type { ReviewDiffCliRequest, ReviewDiffSession } from '@dts/common/review-diff'

const REVIEW_DIFF_COMMAND = 'review-diff'
const BASELINE_HASH_PATTERN = /^[a-f0-9]{64}$/i

export function isReviewDiffInvocation (argv: string[]): boolean {
  return argv.includes(REVIEW_DIFF_COMMAND)
}

export function parseReviewDiffCliRequest (argv: string[], cwd: string = process.cwd()): ReviewDiffCliRequest|null {
  const commandIndex = argv.indexOf(REVIEW_DIFF_COMMAND)
  if (commandIndex === -1) {
    return null
  }

  let documentPath: string|undefined
  let patchPath: string|undefined
  let baselineSha256: string|undefined
  let description: string|undefined

  for (let idx = commandIndex + 1; idx < argv.length; idx++) {
    const arg = argv[idx]
    const readValue = (name: string): string => {
      if (idx + 1 >= argv.length) {
        throw new Error(`Missing value for ${name}`)
      }
      idx += 1
      return argv[idx]
    }

    if (arg === '--document') {
      documentPath = readValue('--document')
    } else if (arg.startsWith('--document=')) {
      documentPath = arg.slice('--document='.length)
    } else if (arg === '--patch') {
      patchPath = readValue('--patch')
    } else if (arg.startsWith('--patch=')) {
      patchPath = arg.slice('--patch='.length)
    } else if (arg === '--baseline-sha256' || arg === '--baseline-hash') {
      baselineSha256 = readValue(arg)
    } else if (arg.startsWith('--baseline-sha256=')) {
      baselineSha256 = arg.slice('--baseline-sha256='.length)
    } else if (arg.startsWith('--baseline-hash=')) {
      baselineSha256 = arg.slice('--baseline-hash='.length)
    } else if (arg === '--description') {
      description = readValue('--description')
    } else if (arg.startsWith('--description=')) {
      description = arg.slice('--description='.length)
    } else {
      throw new Error(`Unsupported review-diff argument: ${arg}`)
    }
  }

  if (documentPath === undefined) {
    throw new Error('review-diff requires --document')
  }

  if (patchPath === undefined) {
    throw new Error('review-diff requires --patch')
  }

  return {
    documentPath: path.resolve(cwd, documentPath),
    patchPath: path.resolve(cwd, patchPath),
    baselineSha256,
    description
  }
}

export function buildReviewDiffSession (request: ReviewDiffCliRequest): ReviewDiffSession {
  const baselineText = readNormalizedTextFile(request.documentPath)

  return buildReviewDiffSessionFromBaseline({
    documentPath: request.documentPath,
    patchPath: request.patchPath,
    baselineSha256: request.baselineSha256,
    diskBaselineSha256: sha256Text(baselineText),
    baselineText,
    description: request.description
  })
}

export interface ReviewDiffSessionFromBaselineRequest {
  documentPath: string
  baselineText: string
  baselineSha256?: string
  diskBaselineSha256?: string
  patchPath?: string
  patchText?: string
  proposedText?: string
  description?: string
}

export function buildReviewDiffSessionFromBaseline (request: ReviewDiffSessionFromBaselineRequest): ReviewDiffSession {
  if (!hasMdOrCodeExt(request.documentPath)) {
    throw new Error('review-diff only supports Markdown and code text documents')
  }

  const baselineText = normalizeText(request.baselineText)
  const baselineSha256 = sha256Text(baselineText)

  if (request.baselineSha256 !== undefined) {
    if (!BASELINE_HASH_PATTERN.test(request.baselineSha256)) {
      throw new Error('review-diff baseline hash must be a SHA-256 hex digest')
    }

    if (request.baselineSha256.toLowerCase() !== baselineSha256) {
      throw new Error('review-diff baseline hash does not match the target document')
    }
  }

  const proposedText = buildProposedText(request, baselineText)

  if (proposedText === false) {
    throw new Error('review-diff patch does not apply to the target document baseline')
  }

  if (proposedText === baselineText) {
    throw new Error('review-diff patch does not change the target document')
  }

  return {
    id: randomUUID(),
    documentPath: request.documentPath,
    patchPath: request.patchPath,
    baselineSha256,
    diskBaselineSha256: request.diskBaselineSha256 ?? baselineSha256,
    baselineText,
    originalText: baselineText,
    proposedText,
    currentText: proposedText,
    description: request.description
  }
}

export function validateReviewDiffInvocation (argv: string[], cwd: string = process.cwd()): void {
  const request = parseReviewDiffCliRequest(argv, cwd)
  if (request !== null) {
    buildReviewDiffSession(request)
  }
}

export function sha256Text (content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export function readNormalizedTextFile (filePath: string): string {
  return normalizeText(fs.readFileSync(filePath, { encoding: 'utf8' }))
}

export function normalizeText (content: string): string {
  return content
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\n\r|\n|\r/g)
    .join('\n')
}

function buildProposedText (request: ReviewDiffSessionFromBaselineRequest, baselineText: string): string|false {
  if (request.proposedText !== undefined) {
    if (request.patchPath !== undefined || request.patchText !== undefined) {
      throw new Error('review-diff accepts either proposed text or a patch, not both')
    }

    return normalizeText(request.proposedText)
  }

  const patchText = request.patchText ?? (
    request.patchPath !== undefined ? fs.readFileSync(request.patchPath, { encoding: 'utf8' }) : undefined
  )

  if (patchText === undefined) {
    throw new Error('review-diff requires either proposed text or a patch')
  }

  const patch = getSingleSupportedPatch(parsePatch(patchText), request.documentPath)
  return applyPatch(baselineText, patch, {
    autoConvertLineEndings: true,
    fuzzFactor: 0
  })
}

function getSingleSupportedPatch (patches: StructuredPatch[], documentPath: string): StructuredPatch {
  if (patches.length !== 1) {
    throw new Error('review-diff requires exactly one file patch')
  }

  const patch = patches[0]
  if (patch.hunks.length === 0) {
    throw new Error('review-diff requires a text patch with at least one hunk')
  }

  if (patch.isBinary === true) {
    throw new Error('review-diff does not support binary patches')
  }

  if (patch.isRename === true || patch.isCopy === true || patch.isCreate === true || patch.isDelete === true) {
    throw new Error('review-diff does not support rename, copy, create, or delete patches')
  }

  if (patch.oldMode !== undefined || patch.newMode !== undefined) {
    throw new Error('review-diff does not support mode-change patches')
  }

  if (isDevNull(patch.oldFileName) || isDevNull(patch.newFileName)) {
    throw new Error('review-diff does not support create or delete patches')
  }

  if (!patchHeaderMatchesDocument(patch.oldFileName, documentPath) || !patchHeaderMatchesDocument(patch.newFileName, documentPath)) {
    throw new Error('review-diff patch headers do not match the target document')
  }

  return patch
}

function isDevNull (fileName: string|undefined): boolean {
  return fileName === '/dev/null'
}

function patchHeaderMatchesDocument (fileName: string|undefined, documentPath: string): boolean {
  if (fileName === undefined) {
    return false
  }

  const normalizedName = fileName.replace(/\\/g, '/').replace(/^(a|b)\//, '')
  if (!path.isAbsolute(normalizedName)) {
    return false
  }

  return path.resolve(normalizedName) === path.resolve(documentPath)
}
