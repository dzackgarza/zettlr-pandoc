import type {
  ExternalLinter,
  ExternalLinterRunResponse,
} from "@common/diagnostics/external-linter";
import { remoteErrorMessage } from "@common/util/ipc-rejection";

export function ipcExternalLinter<
  Context extends Record<string, unknown> = Record<string, unknown>,
  Metadata = Record<string, unknown>,
>(id: string): ExternalLinter<Context, Metadata> {
  return {
    id,
    async run({ text, context }) {
      const result: ExternalLinterRunResponse = await window.ipc
        .invoke("application", {
          command: "run-external-linter",
          payload: {
            id,
            text,
            context,
          },
        })
        .catch((failure: Error) => {
          // The editor shows the cause in the words of the main process.
          throw new Error(remoteErrorMessage(failure), { cause: failure });
        });
      return {
        diagnostics: result.diagnostics,
        ...(result.metadata === undefined ? {} : { metadata: result.metadata as Metadata }),
      };
    },
  };
}
