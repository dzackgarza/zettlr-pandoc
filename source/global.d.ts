/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Global Typings
 * CVM-Role:        Types
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file contains global types for the main process's providers.
 *
 * END HEADER
 */

// We cannot have any imports or exports, as otherwise this file would not
// be read in by TypeScript as an ambient module declaration.
// More info: https://stackoverflow.com/a/35074833

/**
 * DECLARE ANY OTHER FILETYPES
 *
 * These filetypes can be "imported" but their resolved value will be a string
 * pointing to wherever the file-loader has put these files.
 */
declare module "*.png" {
  const filePath: string;
  export default filePath;
}
declare module "*.svg" {
  const filePath: string;
  export default filePath;
}
declare module "*.mp3" {
  const filePath: string;
  export default filePath;
}
declare module "*.wav" {
  const filePath: string;
  export default filePath;
}
declare module "*.glsl" {
  const content: string;
  export default content;
}
declare module "*.css" {
  const filePath: string;
  export default filePath;
}

// Declare modules which don't offer types
declare module "@joplin/turndown";
declare module "joplin-turndown-plugin-gfm";
// @replit/codemirror-emacs ships dist/index.d.ts, but its "exports" map has
// no "types" condition, so resolvers running under node16/bundler semantics
// (the typed lint, for one) cannot see it. Declare the one entry point we
// use, typed — a bare declaration would erase the real types to `any`.
declare module "@replit/codemirror-emacs" {
  import { type Extension } from "@codemirror/state";
  export function emacs(): Extension;
}
declare module "@replit/codemirror-lang-nix";
// Declare all legacy-modes plugins at once
declare module "@codemirror/legacy-modes/*";

/**
 * DECLARE ELECTRON-FORGE INSERTION VARIABLES
 *
 * These variables are set by electron-forge to point to the relevant entrypoints.
 */

declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const ABOUT_PRELOAD_WEBPACK_ENTRY: string;
declare const ABOUT_WEBPACK_ENTRY: string;
declare const ASSETS_PRELOAD_WEBPACK_ENTRY: string;
declare const ASSETS_WEBPACK_ENTRY: string;
declare const ERROR_PRELOAD_WEBPACK_ENTRY: string;
declare const ERROR_WEBPACK_ENTRY: string;
declare const LOG_VIEWER_PRELOAD_WEBPACK_ENTRY: string;
declare const LOG_VIEWER_WEBPACK_ENTRY: string;
declare const PASTE_IMAGE_PRELOAD_WEBPACK_ENTRY: string;
declare const PASTE_IMAGE_WEBPACK_ENTRY: string;
declare const PREFERENCES_PRELOAD_WEBPACK_ENTRY: string;
declare const PREFERENCES_WEBPACK_ENTRY: string;
declare const PRINT_PRELOAD_WEBPACK_ENTRY: string;
declare const PRINT_WEBPACK_ENTRY: string;
declare const STATS_PRELOAD_WEBPACK_ENTRY: string;
declare const STATS_WEBPACK_ENTRY: string;
declare const TAG_MANAGER_PRELOAD_WEBPACK_ENTRY: string;
declare const TAG_MANAGER_WEBPACK_ENTRY: string;
declare const UPDATE_PRELOAD_WEBPACK_ENTRY: string;
declare const UPDATE_WEBPACK_ENTRY: string;
declare const PROJECT_PROPERTIES_PRELOAD_WEBPACK_ENTRY: string;
declare const PROJECT_PROPERTIES_WEBPACK_ENTRY: string;
declare const SPLASH_SCREEN_WEBPACK_ENTRY: string;
declare const SPLASH_SCREEN_PRELOAD_WEBPACK_ENTRY: string;
declare const ONBOARDING_WEBPACK_ENTRY: string;
declare const ONBOARDING_PRELOAD_WEBPACK_ENTRY: string;

// Contains the git build number and date
declare const __GIT_COMMIT_HASH__: string;
declare const __BUILD_DATE__: string;
declare const __UPDATES_DISABLED__: "1" | "0";

declare interface Window {
  /**
   * The config API provides methods to read and set configuration values
   */
  config: {
    /**
     * Returns the config value associated with the provided key. If key is
     * undefined, returns the full configuration. The caller knows which
     * option it asked for and states the expected type through T (or handles
     * the default unknown); the config template is the source of truth.
     *
     * @param   {string}  key  The key to retrieve
     *
     * @return  {T}            The value associated with key
     */
    get: <T = unknown>(key?: string) => T;
    /**
     * Sets the configuration value associated with key to value.
     *
     * @param   {string}  key    The key to set
     * @param   {any}     value  The value to set the key to
     */
    set: (key: string, value: unknown) => void;
  };
  /**
   * Takes citation items and returns a rendered citation from main
   *
   * @param   {string}      database   The database to request from
   * @param   {CiteItem[]}  citations  The cite items (as CSL JSON)
   * @param   {boolean}     composite  Whether the citation is composite
   *
   * @return  {string|undefined}       The rendered citation, or undefined
   */
  getCitationCallback: (
    database: string,
  ) => (citations: CiteItem[], composite: boolean) => string | undefined;
  ipc: {
    /**
     * Sends a message to main (fire-and-forget)
     *
     * @param   {string}     channel  The channel to send upon
     * @param   {unknown[]}  args     Arguments to provide
     *
     */
    send: (channel: string, ...args: unknown[]) => void;
    /**
     * Sends a synchronous message and returns the response immediately. The
     * caller states the expected response type through T (or handles the
     * default unknown).
     *
     * @param   {string}     event  The channel to send upon
     * @param   {unknown[]}  args   Arguments for that call
     *
     * @return  {T}                 Whichever this call returns from main
     */
    sendSync: <T = unknown>(event: string, ...args: unknown[]) => T;
    /**
     * Sends a message to main and returns a promise which fulfills with the
     * response from main. Every channel's request and response type lives
     * beside its owning handler; source/types/renderer/ipc-bridge.ts
     * composes those contracts and contributes this global alias — a wrong
     * channel, command, or payload is a compile error at the call site.
     */
    invoke: ZettlrIpcInvoke;
    /**
     * Listens to broadcasted messages from main. The listener's rest
     * parameters are typed never[]: the bridge does not know a channel's
     * broadcast payload, so the listener must annotate the payload it
     * expects (never is assignable to every annotation).
     *
     * @param   {string}     channel   The channel on which to listen
     * @param   {undefined}  listener  An event. This will always be omitted and undefined.
     *
     * @return {Function}  A function to stop listening (remove the listener)
     */
    on: (channel: string, listener: (event: undefined, ...args: never[]) => void) => () => void;
  };
  /**
   * Returns the absolute path to the file on disk which this File object is
   * representing. Returns undefined if there was either an error or the File
   * object does not represent a file on disk.
   *
   * @param   {File}              file  The web File object
   *
   * @return  {string|undefined}        The absolute path, or undefined.
   */
  getPathForFile: (file: File) => string | undefined;
}
