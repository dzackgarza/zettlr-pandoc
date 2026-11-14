/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ZettlrCommand class
 * CVM-Role:        Controller
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This class represents the base for all commands that can be
 *                  issued from the renderer, such as creating files, removing
 *                  directories, etc. Other command classes should extend it and
 *                  implement specific behaviour.
 *
 * END HEADER
 */

import { type AppServiceContainer } from "../../app-service-container";

/**
 * A command of the application. `Services` is the part of the service
 * container that the command uses; a command that states none gets the whole
 * container. The handler map of `CommandProvider` names the commands of the
 * contract that a command answers, and each command declares the methods
 * that its handlers call with the types of the contract.
 */
export default abstract class ZettlrCommand<Services = AppServiceContainer> {
  protected readonly _app: Services;

  constructor(app: Services) {
    // The app is the api entry point for all things we can do.
    this._app = app;
  }

  /** Called when the app stops. A command that owns a process stops it here. */
  async shutdown(): Promise<void> {}
}
