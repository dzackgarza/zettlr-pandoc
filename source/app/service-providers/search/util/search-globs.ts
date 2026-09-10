/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Search path filters
 * CVM-Role:        Utility
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Which files a query admits: the include and exclude
 *                  globs of VS Code's search details, compiled to one
 *                  predicate over a workspace-relative path. This lives
 *                  apart from the query itself because globs are matched
 *                  where the files are — in the main process — while the
 *                  query's pattern is also compiled in the renderer, to
 *                  show what a replacement would do.
 *
 * END HEADER
 */

import picomatch from 'picomatch'

/**
 * One glob the way a search field means it: `*.md` matches at any depth,
 * `src/*.md` only where it says. Several patterns are separated by commas,
 * and an empty field names no pattern at all.
 */
function compileGlobs (patterns: string): ((relativePath: string) => boolean) | undefined {
  const globs = patterns.split(',').map(glob => glob.trim()).filter(glob => glob !== '')
  if (globs.length === 0) {
    return undefined
  }
  const matchers = globs.map(glob => picomatch(glob.includes('/') ? glob : `**/${glob}`, { dot: true }))
  return relativePath => matchers.some(matches => matches(relativePath))
}

/**
 * The predicate a search walks the workspace with: a file has to pass the
 * include globs, if there are any, and must not match an exclude glob.
 *
 * @param   {string}  include  Comma-separated globs, or ''
 * @param   {string}  exclude  Comma-separated globs, or ''
 *
 * @return  {(relativePath: string) => boolean}  Whether to search that file
 */
export function compilePathFilter (include: string, exclude: string): (relativePath: string) => boolean {
  const included = compileGlobs(include)
  const excluded = compileGlobs(exclude)
  return relativePath => {
    if (included !== undefined && !included(relativePath)) {
      return false
    }
    return excluded === undefined || !excluded(relativePath)
  }
}
