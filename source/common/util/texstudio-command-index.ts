import type { TexCommandVocabulary, TexstudioCommandIndex } from "@dts/common/tex-vocabulary";

export interface TexCommandAuthority {
  activePackages: ReadonlySet<string>;
  activeCommands: ReadonlySet<string>;
  providersByCommand: ReadonlyMap<string, readonly string[]>;
}

const providerCache = new WeakMap<TexstudioCommandIndex, Map<string, readonly string[]>>();

/**
 * The entries that the roots load, through the `includes` of each entry. A
 * name that the index does not have loads nothing: Flowmark's
 * `_texstudio_package_closure`.
 */
export function closeTexstudioPackages(
  index: TexstudioCommandIndex,
  roots: Iterable<string>,
): Set<string> {
  const active = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (active.has(name)) {
      continue;
    }
    const entry = index.packages[name];
    if (entry === undefined) {
      continue;
    }
    active.add(name);
    for (const dependency of entry.includes) {
      if (!active.has(dependency)) {
        pending.push(dependency);
      }
    }
  }
  return active;
}

/** The entries that declare each command, built once for an index. */
export function providersByTexCommand(
  index: TexstudioCommandIndex,
): Map<string, readonly string[]> {
  const cached = providerCache.get(index);
  if (cached !== undefined) {
    return cached;
  }
  const providers = new Map<string, string[]>();
  for (const [packageName, entry] of Object.entries(index.packages)) {
    for (const command of entry.commands) {
      const existing = providers.get(command);
      if (existing === undefined) {
        providers.set(command, [packageName]);
      } else {
        existing.push(packageName);
      }
    }
  }
  providerCache.set(index, providers);
  return providers;
}

/**
 * The commands that `tex/unknown-command` accepts in a document whose TeX
 * loads `documentRoots`: the commands of the closure of the packages of the
 * lint context and of those roots.
 */
export function buildTexCommandAuthority(
  vocabulary: TexCommandVocabulary,
  documentRoots: Iterable<string>,
): TexCommandAuthority {
  const { index } = vocabulary;
  const activePackages = closeTexstudioPackages(index, [...vocabulary.packages, ...documentRoots]);
  const activeCommands = new Set<string>();
  // closeTexstudioPackages admits only entries of the index.
  for (const packageName of activePackages) {
    for (const command of index.packages[packageName].commands) {
      activeCommands.add(command);
    }
  }
  return {
    activePackages,
    activeCommands,
    providersByCommand: providersByTexCommand(index),
  };
}
