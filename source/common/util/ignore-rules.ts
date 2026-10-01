/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Ignore rules
 * CVM-Role:        Utility
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The rules that say which files and folders of a workspace
 *                  the app lists. A rule is one gitignore line; the `ignore`
 *                  package is the matcher. The main process filters with this
 *                  module, and the windows use it to mark what a rule matches,
 *                  so it imports nothing that only one of them has. Paths use
 *                  `/` as the separator.
 *
 * END HEADER
 */

import ignore, { type Ignore } from 'ignore'

/** The rules file at a workspace root. Its rules add to the global ones. */
export const WORKSPACE_RULES_FILE = '.zettlrignore'

/** The rule sources. One value is immutable; a change makes a new one. */
export interface IgnoreRuleSources {
  /** The configuration value `fileManager.ignoreRules`, one gitignore line each. */
  globalRules: readonly string[]
  /** Each open workspace root and the text of its rules file ('' when it has none). */
  workspaceRules: ReadonlyMap<string, string>
  /** The configuration value `fileManager.showIgnored`: the reveal toggle. */
  showIgnored: boolean
}

/** What the rules say about one path. */
export interface IgnoreFilter {
  /** True when a rule matches the path, whatever the reveal toggle says. */
  matches: (absPath: string, isDirectory: boolean) => boolean
  /** True when the app must not list the path: a rule matches and the reveal toggle is off. */
  hides: (absPath: string, isDirectory: boolean) => boolean
}

/**
 * A rule of a rules file that names a path at or below a given path.
 * `rest` is what follows that path in the rule: '' or '/' for the path itself,
 * '/sub/…' for a path below it.
 */
export interface PathRule {
  negated: boolean
  rest: string
}

/**
 * Makes the filter of one set of rule sources. A path is judged by the
 * innermost workspace root that contains it, with the global rules and then
 * the rules file of that root. A root is not inside itself, so no rule hides
 * a root in its own tree, and a path outside every root is never matched.
 */
export function createIgnoreFilter (sources: IgnoreRuleSources): IgnoreFilter {
  const roots = [...sources.workspaceRules.keys()].sort((a, b) => b.length - a.length)
  const matchers = new Map<string, Ignore>()

  const matcherOf = (root: string): Ignore => {
    let matcher = matchers.get(root)
    if (matcher === undefined) {
      matcher = ignore({ ignorecase: false })
        .add(sources.globalRules)
        .add(sources.workspaceRules.get(root) ?? '')
      matchers.set(root, matcher)
    }
    return matcher
  }

  const matches = (absPath: string, isDirectory: boolean): boolean => {
    const root = roots.find(candidate => absPath.startsWith(`${candidate}/`))
    if (root === undefined) {
      return false
    }
    const relative = absPath.slice(root.length + 1)
    return matcherOf(root).ignores(isDirectory ? `${relative}/` : relative)
  }

  return {
    matches,
    hides: (absPath, isDirectory) => !sources.showIgnored && matches(absPath, isDirectory)
  }
}

/**
 * Writes a file or folder name as a pattern that matches that name only.
 * gitignore(5): a backslash quotes `\`, `*`, `?`, `[` and `]`, a `#` or `!`
 * at the start of a line, and a trailing space.
 */
function escapeLiteral (text: string): string {
  return text
    .replace(/[\\*?[\]]/g, '\\$&')
    .replace(/^[#!]/, '\\$&')
    .replace(/ $/, '\\ ')
}

/** The path below `root`, written as the literal start of an anchored rule. */
function anchoredLiteral (root: string, absPath: string): string {
  if (!absPath.startsWith(`${root}/`)) {
    throw new Error(`Cannot write a rule for ${absPath}: it is not inside ${root}`)
  }
  return '/' + absPath.slice(root.length + 1).split('/').map(escapeLiteral).join('/')
}

/** The rule that matches every file, or every folder, with this name. */
export function ruleForName (name: string, isDirectory: boolean): string {
  return escapeLiteral(name) + (isDirectory ? '/' : '')
}

/** The rule that matches this one path of the workspace `root`. */
export function ruleForPath (root: string, absPath: string, isDirectory: boolean): string {
  return anchoredLiteral(root, absPath) + (isDirectory ? '/' : '')
}

function linesOf (text: string): string[] {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines
}

function textOf (lines: string[]): string {
  return lines.length === 0 ? '' : lines.join('\n') + '\n'
}

/**
 * Returns the rules file text of `root` after one path is hidden or shown
 * again. Hide removes a negation of the path, then adds the rule of the path
 * when the path is still listed. Unhide removes the rule of the path, then
 * adds a negation when a pattern still matches it. Every other line stays.
 *
 * @throws when the path stays hidden because a folder above it is hidden;
 *         gitignore cannot list a path again below a hidden folder.
 */
export function setPathIgnored (
  text: string,
  globalRules: readonly string[],
  root: string,
  absPath: string,
  isDirectory: boolean,
  ignored: boolean
): string {
  const rule = ruleForPath(root, absPath, isDirectory)
  const negation = `!${rule}`
  const isIgnored = (lines: string[]): boolean => {
    const workspaceRules = new Map([[ root, textOf(lines) ]])
    return createIgnoreFilter({ globalRules, workspaceRules, showIgnored: false }).matches(absPath, isDirectory)
  }

  const lines = linesOf(text).filter(line => line !== (ignored ? negation : rule))
  if (isIgnored(lines) !== ignored) {
    lines.push(ignored ? rule : negation)
  }
  if (isIgnored(lines) !== ignored) {
    throw new Error(`Cannot show ${absPath}: a folder above it is hidden`)
  }
  return textOf(lines)
}

/**
 * Rewrites the rules of a rules file that name `absPath` or a path below it.
 * `map` returns the new line of such a rule, or undefined to remove the rule.
 * Every other line stays. This keeps the rules in step with a rename, a move
 * or a deletion of the path.
 */
export function mapPathRules (
  text: string,
  root: string,
  absPath: string,
  map: (rule: PathRule) => string|undefined
): string {
  const literal = anchoredLiteral(root, absPath)
  const lines: string[] = []
  for (const line of linesOf(text)) {
    const negated = line.startsWith('!')
    const body = negated ? line.slice(1) : line
    const rest = body.slice(literal.length)
    if (!body.startsWith(literal) || (rest !== '' && !rest.startsWith('/'))) {
      lines.push(line)
      continue
    }
    const mapped = map({ negated, rest })
    if (mapped !== undefined) {
      lines.push(mapped)
    }
  }
  return textOf(lines)
}

/** The line of a path rule after its path became `absPath` in the workspace `root`. */
export function pathRuleLine (root: string, absPath: string, rule: PathRule): string {
  return (rule.negated ? '!' : '') + anchoredLiteral(root, absPath) + rule.rest
}
