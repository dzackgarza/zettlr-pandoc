import { app as electronApp } from 'electron'
import type {
  ExternalDiagnostic,
  ExternalDiagnosticAction,
  ExternalLinterRunRequest,
  ExternalLinterRunResponse
} from '@common/diagnostics/external-linter'
import type { AppServiceContainer } from 'source/app/app-service-container'
import {
  createDocumentLintContext,
  lintDocumentText
} from './document-lint'
import { documentLintAuthority } from './document-bibliographies'
import { resolveTikzRenderConfig } from './resolve-tikz-render-config'
import {
  externalLinterPluginPath,
  runFlowmarkProcess,
  vendoredFlowmarkProjectPath
} from './flowmark-runtime'

export interface ExternalLinterBackend {
  id: string
  run: (
    app: AppServiceContainer,
    request: ExternalLinterRunRequest
  ) => Promise<ExternalLinterRunResponse>
}

function strings (value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

async function runFlowmarkBackend (
  app: AppServiceContainer,
  request: ExternalLinterRunRequest
): Promise<ExternalLinterRunResponse> {
  const sourcePath = typeof request.context?.sourcePath === 'string'
    ? request.context.sourcePath
    : ''
  const mainLibrary = app.config.get().export.cslLibrary
  const bibliographies = sourcePath === ''
    ? (mainLibrary === '' ? [] : [mainLibrary])
    : (await documentLintAuthority(app.fsal, mainLibrary, sourcePath)).bibliographies
  const projectRoots = strings(request.context?.projectRoots)
  const tikz = app.config.get().tikz
  const shared = await createDocumentLintContext({
    homeDirectory: electronApp.getPath('home'),
    env: process.env,
    referenceState: app.references.getSnapshot(),
    tikzRenderConfig: resolveTikzRenderConfig(
      tikz?.dataDir ?? '',
      tikz?.figuresDir ?? '',
      electronApp.getPath('home'),
      electronApp.getPath('userData'),
      process.env
    )
  })
  const diagnostics = await lintDocumentText(
    request.text,
    sourcePath,
    shared,
    { bibliographies, projectRoots }
  )
  return {
    diagnostics: diagnostics.map((diagnostic): ExternalDiagnostic => ({
      from: diagnostic.from,
      to: diagnostic.to,
      severity: diagnostic.severity,
      message: diagnostic.message,
      source: diagnostic.rule === undefined
        ? diagnostic.source
        : diagnostic.source + ' (' + diagnostic.rule + ')',
      data: diagnostic.data,
      actions: diagnostic.suggestions?.map((suggestion): ExternalDiagnosticAction => ({
        kind: 'replace',
        name: suggestion.title,
        replacement: suggestion.replacement
      }))
    }))
  }
}

function externalLinterResponse (raw: string): ExternalLinterRunResponse {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('External linter returned a non-object payload.')
  }
  const candidate = parsed as Partial<ExternalLinterRunResponse>
  if (!Array.isArray(candidate.diagnostics)) {
    throw new Error('External linter returned no diagnostics array.')
  }
  return {
    diagnostics: candidate.diagnostics,
    ...(candidate.metadata === undefined ? {} : { metadata: candidate.metadata })
  }
}

async function runLanguageToolBackend (
  app: AppServiceContainer,
  request: ExternalLinterRunRequest
): Promise<ExternalLinterRunResponse> {
  const config = app.config.getConfig().editor.lint.languageTool
  const disabledRules = [
    ...new Set([
      ...config.ignoredRules.map(rule => rule.id),
      ...strings(request.context?.disabledRules)
    ])
  ]
  const context: Record<string, unknown> = {
    ...request.context,
    active: config.active,
    level: config.level,
    motherTongue: config.motherTongue,
    variants: config.variants,
    backend: config.provider,
    customServer: config.customServer,
    username: config.username,
    apiKey: config.apiKey,
    disabledRules
  }
  const outcome = await runFlowmarkProcess({
    argv: [
      'run',
      '--project', vendoredFlowmarkProjectPath(),
      '--isolated',
      '--frozen',
      'python',
      externalLinterPluginPath('language_tool.py')
    ],
    input: JSON.stringify({ text: request.text, context }),
    env: process.env,
    timeoutMs: 60_000
  })
  if (!outcome.ok) {
    return {
      diagnostics: [],
      metadata: { lastError: outcome.message }
    }
  }
  try {
    return externalLinterResponse(outcome.stdout)
  } catch (error) {
    return {
      diagnostics: [],
      metadata: {
        lastError: error instanceof Error ? error.message : String(error)
      }
    }
  }
}

const BACKENDS = new Map<string, ExternalLinterBackend>()

export function registerExternalLinterBackend (
  backend: ExternalLinterBackend
): void {
  if (BACKENDS.has(backend.id)) {
    throw new Error('External linter already registered: ' + backend.id)
  }
  BACKENDS.set(backend.id, backend)
}

registerExternalLinterBackend({
  id: 'flowmark',
  run: runFlowmarkBackend
})

registerExternalLinterBackend({
  id: 'language-tool',
  run: runLanguageToolBackend
})

export function registeredExternalLinters (): string[] {
  return [...BACKENDS.keys()].sort()
}

export async function runExternalLinter (
  app: AppServiceContainer,
  request: ExternalLinterRunRequest
): Promise<ExternalLinterRunResponse> {
  const backend = BACKENDS.get(request.id)
  if (backend === undefined) {
    throw new Error('Unknown external linter: ' + request.id)
  }
  return await backend.run(app, request)
}
