/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ProviderContract
 * CVM-Role:        Class Contract
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This class is the base for all service providers and defines
 *                  their external API.
 *
 * END HEADER
 */

/**
 * This is a generic type that takes a map of command->payload and transforms it
 * into the `{ command: string, payload: any }` object structure that Zettlr
 * uses across the application. This describes commands to be send from the
 * renderer towards the main processes' service providers.
 *
 * To use it, define an interface of shape
 * `Record<command: string, payload: any>` and pass it as the generic parameter
 * of `IPCAPI`. Example:
 *
 * ```ts
 * interface ProviderAPIMap {
 *   commandName: { property1: string, property2: number }
 * }
 *
 * type ProviderAPI = IPCAPI<ProviderAPIMap>
 *
 * // ...
 * ipcMain.handle('provider-name', (event, message: ProviderAPI) => { ... })
 * ```
 */
export type IPCAPI<T> = {
  // Commands declared with an `unknown` payload take no payload at all; the
  // property is optional for them so call sites can send the bare command.
  [K in keyof T]: unknown extends T[K]
    ? { command: K; payload?: undefined }
    : { command: K; payload: T[K] };
}[keyof T]; // This last thing is required to get from key->value to value only.

/**
 * A provider's owned IPC contract: for each command, the message fields
 * beside `command` (usually `{ payload: X }`, or `{ payload?: undefined }`
 * for commands without one) and the handler's response. Declared next to the
 * ipcMain.handle() that implements it; the renderer's window.ipc.invoke type
 * is composed from these maps in source/types/renderer/ipc-bridge.ts.
 */
export type IPCContract = Record<string, { request: object; response: unknown }>;

/**
 * The message union of a contract — what ipcMain.handle() receives and
 * window.ipc.invoke() sends.
 */
export type IPCMessage<T extends IPCContract> = {
  [K in keyof T]: { command: K } & T[K]["request"];
}[keyof T];

export default abstract class ProviderContract {
  /**
   * Service providers implement a boot method which must be called after
   * instantiation of the singleton.
   *
   * @return  {Promise<void>}  boot must return a Promise.
   */
  public async boot(): Promise<void> {
    // An empty default implementation for providers who don't require their own
    // boot logic.
  }

  /**
   * Service providers implement a shutdown method which must be called before
   * the application shuts down.
   *
   * @return  {<Promise><void>}  shutdown must return a Promise.
   */
  public abstract shutdown(): Promise<void>;
}
