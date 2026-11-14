/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Main-process invoke handler contract fixtures
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Compile-time fixtures for the handlers of the invoke
 *                  channels in the main process (handleInvokeChannel,
 *                  handleFixedChannel, handleBareChannel), checked by the
 *                  typecheck (test/ is in the tsconfig include), as
 *                  ipc-invoke-channels.contract.ts does for the call of a
 *                  window. A @ts-expect-error that stops being an error is a
 *                  compile failure. The handlers take their types from the
 *                  channel tables that type the call of a window (#57).
 *                  The handler map of the application channel
 *                  (ApplicationHandlers) takes its types from
 *                  ApplicationIPCContract.
 *
 * END HEADER
 */

import type { ApplicationHandlers } from "source/app/service-providers/commands";
import type {
  handleBareChannel,
  handleFixedChannel,
  handleInvokeChannel,
} from "source/app/util/handle-ipc-channel";

declare const handleInvoke: typeof handleInvokeChannel;
declare const handleFixed: typeof handleFixedChannel;
declare const handleBare: typeof handleBareChannel;

/** Each command has a handler that takes its message and gives its response. */
export function handlesEachCommand(): void {
  handleInvoke("css-provider", {
    "get-custom-css-path": () => "/config/custom.css",
    "get-custom-css": async () => "body {}",
    "set-custom-css": async (_event, message) => {
      const css: string = message.css;
      return void css;
    },
  });
}

export function missesACommand(): void {
  // @ts-expect-error The map has no handler for set-custom-css.
  handleInvoke("css-provider", {
    "get-custom-css-path": () => "/config/custom.css",
    "get-custom-css": async () => "body {}",
  });
}

export function answersWithTheWrongResponse(): void {
  handleInvoke("css-provider", {
    // @ts-expect-error get-custom-css-path answers a path, not a number.
    "get-custom-css-path": () => 1,
    "get-custom-css": async () => "body {}",
    "set-custom-css": async () => {},
  });
}

export function handlesACommandOutsideTheContract(): void {
  handleInvoke("css-provider", {
    "get-custom-css-path": () => "/config/custom.css",
    "get-custom-css": async () => "body {}",
    "set-custom-css": async () => {},
    // @ts-expect-error The contract of css-provider has no command reset-custom-css.
    "reset-custom-css": async () => {},
  });
}

export function readsAFieldThatTheRequestDoesNotHave(): void {
  handleInvoke("css-provider", {
    "get-custom-css-path": () => "/config/custom.css",
    "get-custom-css": async () => "body {}",
    "set-custom-css": async (_event, message) => {
      // @ts-expect-error set-custom-css carries its text in css, not in payload.
      return void message.payload;
    },
  });
}

/** A fixed channel answers the response of its table. */
export function handlesAFixedChannel(): void {
  handleFixed("close-all", async (_event, { rootType }) => rootType === "workspace");
}

export function answersAFixedChannelWithTheWrongResponse(): void {
  // @ts-expect-error close-all answers whether the roots may close, not the root type.
  handleFixed("close-all", async (_event, { rootType }) => rootType);
}

export function answersABareChannelWithTheWrongResponse(): void {
  // @ts-expect-error request-dir answers a list of paths, not one path.
  handleBare("request-dir", async () => "/notes");
}

export function handlesAChannelOutsideTheTables(): void {
  // @ts-expect-error No table declares a channel of this name.
  handleBare("request-everything", () => []);
}

/** The application channel has a handler for each command of its contract. */
export function missesAnApplicationCommand(
  handlers: Omit<ApplicationHandlers, "root-close">,
): void {
  // @ts-expect-error The map has no handler for root-close.
  const complete: ApplicationHandlers = handlers;
  return void complete;
}

export const rootCloseWithTheWrongResponse: Pick<ApplicationHandlers, "root-close"> = {
  // @ts-expect-error root-close answers whether the roots closed, not the roots.
  "root-close": async (roots) => roots,
};

export const tikzEditOpenWithTheWrongPayload: Pick<ApplicationHandlers, "tikz-edit-open"> = {
  "tikz-edit-open": async (request) => {
    // @ts-expect-error tikz-edit-open takes the diagram, not a session id.
    const sessionId: string = request;
    return sessionId === "" ? { outcome: "file-opened" } : { outcome: "document-unsaved" };
  },
};

export const applicationCommandOutsideTheContract: Partial<ApplicationHandlers> = {
  // @ts-expect-error The contract of application has no command file-new-everywhere.
  "file-new-everywhere": async () => undefined,
};
