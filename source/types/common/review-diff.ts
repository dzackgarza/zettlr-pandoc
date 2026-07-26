export interface ReviewDiffCliRequest {
  documentPath: string
  patchPath: string
  baselineSha256?: string
  description?: string
}

export interface ReviewDiffSession {
  id: string
  documentPath: string
  patchPath: string
  baselineSha256: string
  baselineText: string
  proposedText: string
  description?: string
}

export interface ReviewDiffStatus {
  filePath: string
  sessionId: string
  unresolvedChunks: number
}
