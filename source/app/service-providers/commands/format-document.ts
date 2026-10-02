/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        FormatDocument command
 * CVM-Role:        Controller
 * License:         GNU GPL v3
 *
 * Description:     Thin IPC seam over the flowmark format service (issue #26).
 *                  The renderer sends the current buffer text and the
 *                  document path on the 'format-document' event and receives
 *                  a typed FlowmarkResult; the environment flowmark runs
 *                  under is the one the main process (and thus Electron) was
 *                  started with. Each run is a long-running task, so the
 *                  status bar shows the format while it holds a save.
 *
 * END HEADER
 */

import path from "path";
import { trans } from "source/common/i18n-main";
import { type AppServiceContainer } from "../../app-service-container";
import { type FlowmarkResult, formatMarkdownText } from "../../util/flowmark-format";
import ZettlrCommand from "./zettlr-command";

export interface FormatDocumentRequest {
  text: string;
  /** The document the text belongs to. */
  path: string;
}

export default class FormatDocument extends ZettlrCommand {
  constructor(app: AppServiceContainer) {
    super(app, "format-document");
  }

  async run(evt: string, arg: FormatDocumentRequest): Promise<FlowmarkResult> {
    const task = this._app.lrt.registerTask(
      trans('Formatting "%s"', path.basename(arg.path)),
      "Flowmark",
      undefined,
      false,
    );
    let result: FlowmarkResult;
    try {
      result = await formatMarkdownText(
        arg.text,
        this._app.config.get().editor.formatTimeoutMs,
        process.env,
      );
    } catch (error) {
      this._app.lrt.settleTask(task, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    this._app.lrt.settleTask(task, result.ok ? undefined : new Error(result.message));
    return result;
  }
}
