/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Remote document push retry specs
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The document authority rejects an update that it cannot
 *                  acknowledge: for a document under review, the review file
 *                  could not be written. The update stays unsent in the
 *                  editor. This spec drives the real collab plugin of one
 *                  editor view against an authority that rejects one update
 *                  and then accepts updates again. The editor must send the
 *                  text that the authority rejected: without it no save of
 *                  that editor can succeed (#178).
 *
 * END HEADER
 */

import { sendableUpdates } from "@codemirror/collab";
import { ChangeSet, EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { strict as assert } from "assert";
import { hookDocumentAuthority } from "source/common/modules/markdown-editor/plugins/remote-doc";
import {
  configField,
  getDefaultConfig,
} from "source/common/modules/markdown-editor/util/configuration";
import { dismissAllNotifications, notificationEntries } from "source/common/util/show-toast";
import type { SerializedUpdate } from "source/types/common/documents";

const FILE = "/notes/lattices.md";
const SOURCE = "An even unimodular lattice has a rank that 8 divides.";
const TYPED = " The Leech lattice has rank 24.";
const TYPED_LATER = " It has no roots.";

/** The authority side of the collab protocol, for one document. */
class Authority {
  text = Text.of([SOURCE]);
  readonly updates: SerializedUpdate[] = [];
  /** While true, the authority cannot acknowledge an update. */
  refusing = false;
  refusals = 0;
  private waiting: Array<() => void> = [];

  push = async (
    _filePath: string,
    version: number,
    updates: SerializedUpdate[],
  ): Promise<boolean> => {
    if (this.refusing) {
      this.refusals += 1;
      // The cause of a real rejection names the temporary file of that write,
      // so no two rejections have the same message.
      throw new Error(`The review file review.json.${this.refusals} could not be written`);
    }
    if (version !== this.updates.length) {
      return false;
    }
    for (const update of updates) {
      this.text = ChangeSet.fromJSON(update.changes).apply(this.text);
      this.updates.push(update);
    }
    for (const wake of this.waiting.splice(0)) {
      wake();
    }
    return true;
  };

  pull = async (_filePath: string, version: number): Promise<SerializedUpdate[]> => {
    while (version >= this.updates.length) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    return this.updates.slice(version);
  };
}

async function until(condition: () => boolean, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("An editor whose update the document authority rejected", function () {
  let view: EditorView;
  let authority: Authority;

  beforeEach(function () {
    dismissAllNotifications();
    authority = new Authority();
    const config = getDefaultConfig();
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: SOURCE,
        extensions: [
          configField.init(() => ({ ...config, metadata: { ...config.metadata, path: FILE } })),
          hookDocumentAuthority(FILE, 0, authority.pull, authority.push),
        ],
      }),
    });
  });

  afterEach(function () {
    view.destroy();
  });

  function type(text: string): void {
    view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
  }

  it("sends the rejected text when the authority accepts updates again", async function () {
    authority.refusing = true;
    type(TYPED);
    await until(() => authority.refusals > 0, 2000);
    assert.equal(authority.refusals > 0, true, "the authority rejected the update");
    assert.equal(authority.text.toString(), SOURCE, "a rejected update is not in the authority");

    authority.refusing = false;
    await until(() => sendableUpdates(view.state).length === 0, 5000);
    assert.equal(
      authority.text.toString(),
      `${SOURCE}${TYPED}`,
      "the authority has the text that it rejected before",
    );
    assert.equal(sendableUpdates(view.state).length, 0, "the editor holds no unsent update");
  });

  it("tells the author one time that the document did not take the text", async function () {
    authority.refusing = true;
    type(TYPED);
    await until(() => authority.refusals > 0, 2000);
    const shown = (): string[] =>
      notificationEntries()
        .filter((entry) => entry.kind === "error")
        .map((entry) => entry.message);
    await until(() => shown().length > 0, 2000);
    assert.equal(shown().length, 1, `one error is shown: ${JSON.stringify(shown())}`);
    assert.ok(shown()[0].includes("lattices.md"), `the error names the document: ${shown()[0]}`);

    await until(() => authority.refusals > 1, 5000);
    assert.equal(authority.refusals > 1, true, "the editor sent the update a second time");
    assert.equal(shown().length, 1, "the second rejection of the same update shows no new error");
  });

  it("sends the rejected text together with the text that the author typed after it", async function () {
    authority.refusing = true;
    type(TYPED);
    await until(() => authority.refusals > 0, 2000);
    assert.equal(authority.refusals > 0, true, "the authority rejected the update");

    authority.refusing = false;
    type(TYPED_LATER);
    await until(() => sendableUpdates(view.state).length === 0, 5000);
    assert.equal(authority.text.toString(), `${SOURCE}${TYPED}${TYPED_LATER}`);
    assert.equal(view.state.doc.toString(), `${SOURCE}${TYPED}${TYPED_LATER}`);
  });
});
