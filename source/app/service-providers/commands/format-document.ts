/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        FormatDocument command
 * CVM-Role:        Controller
 * License:         GNU GPL v3
 *
 * Description:     Thin IPC seam over the flowmark format service (issue #26).
 *                  The renderer sends the current buffer text on the
 *                  'format-document' event and receives a typed FlowmarkResult;
 *                  the environment flowmark runs under is the one the main
 *                  process (and thus Electron) was started with.
 *
 * END HEADER
 */

import { type AppServiceContainer } from "../../app-service-container";
import { type FlowmarkResult, formatMarkdownText } from "../../util/flowmark-format";
import ZettlrCommand from "./zettlr-command";

export default class FormatDocument extends ZettlrCommand {
  constructor(app: AppServiceContainer) {
    super(app, "format-document");
  }

  async run(evt: string, arg: string): Promise<FlowmarkResult> {
    return await formatMarkdownText(arg, { env: process.env });
  }
}
