export interface TexstudioPackageRecord {
  /** Direct TeXstudio #include dependencies. */
  i: string[]
  /** Control-sequence names declared by this CWL provider. */
  c: string[]
}

export interface TexstudioCommandIndex {
  v: 1
  source: {
    repository: string
    commit: string
    completionTreeSha256: string
    cwlFiles: number
  }
  /** Baseline providers that are always active. */
  b: string[]
  /** Provider name -> compact provider record. */
  p: Record<string, TexstudioPackageRecord>
}

export interface TexCommandAuthority {
  activePackages: ReadonlySet<string>
  activeCommands: ReadonlySet<string>
  providersByCommand: ReadonlyMap<string, readonly string[]>
}

const providerCache = new WeakMap<TexstudioCommandIndex, Map<string, readonly string[]>>()

/** Resolves TeXstudio #include edges transitively, ignoring missing optional providers. */
export function closeTexstudioPackages (
  index: TexstudioCommandIndex,
  roots: Iterable<string>
): Set<string> {
  const active = new Set<string>()
  const pending = [...roots]
  while (pending.length > 0) {
    const provider = pending.pop()!
    if (active.has(provider)) {
      continue
    }
    const record = index.p[provider]
    if (record === undefined) {
      continue
    }
    active.add(provider)
    for (const dependency of record.i) {
      if (!active.has(dependency)) {
        pending.push(dependency)
      }
    }
  }
  return active
}

/** Builds the reverse command/provider lookup once from the compact package-first index. */
export function providersByTexCommand (
  index: TexstudioCommandIndex
): Map<string, readonly string[]> {
  const cached = providerCache.get(index)
  if (cached !== undefined) {
    return cached
  }
  const providers = new Map<string, string[]>()
  for (const [packageName, record] of Object.entries(index.p)) {
    for (const command of record.c) {
      const existing = providers.get(command)
      if (existing === undefined) {
        providers.set(command, [packageName])
      } else {
        existing.push(packageName)
      }
    }
  }
  providerCache.set(index, providers)
  return providers
}

export function buildTexCommandAuthority (
  index: TexstudioCommandIndex,
  packageRoots: Iterable<string>
): TexCommandAuthority {
  const activePackages = closeTexstudioPackages(index, [ ...index.b, ...packageRoots ])
  const activeCommands = new Set<string>()
  for (const packageName of activePackages) {
    for (const command of index.p[packageName]?.c ?? []) {
      activeCommands.add(command)
    }
  }
  return {
    activePackages,
    activeCommands,
    providersByCommand: providersByTexCommand(index)
  }
}

export type TexCommandClassification =
  | { kind: 'active' }
  | { kind: 'inactive-package', providers: readonly string[] }
  | { kind: 'unknown' }

export function classifyTexCommand (
  command: string,
  authority: TexCommandAuthority
): TexCommandClassification {
  if (authority.activeCommands.has(command)) {
    return { kind: 'active' }
  }
  const providers = authority.providersByCommand.get(command)
  return providers === undefined
    ? { kind: 'unknown' }
    : { kind: 'inactive-package', providers }
}
