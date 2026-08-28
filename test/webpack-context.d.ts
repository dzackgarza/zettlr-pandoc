/**
 * Minimal typing for webpack's require.context, used by webpack-bundled
 * probe entries (the repository does not depend on @types/webpack-env).
 * Merges into @types/node's global NodeJS.Require interface, which is the
 * type of the global `require` binding.
 */
interface WebpackRequireContext {
  keys: () => string[];
  (id: string): unknown;
}

declare namespace NodeJS {
  interface Require {
    context: (
      directory: string,
      useSubdirectories: boolean,
      regExp: RegExp,
    ) => WebpackRequireContext;
  }
}
