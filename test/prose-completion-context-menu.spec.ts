// Installs process-wide test doubles; it must load before the modules that read them.
import "./provision-renderer-window-seams";
import { strict as assert } from "node:assert";
import "./provision-renderer-window-seams";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { DictionaryProviderIPCContract } from "source/app/service-providers/dictionary/ipc-contract";
import { proseCompletionMenuItem } from "source/common/modules/markdown-editor/context-menu/default-menu";
import markdownParser from "source/common/modules/markdown-editor/parser/markdown-parser";

// default-menu.ts intentionally captures the preload bridge once at module
// evaluation. Other specs may replace window.ipc wholesale later, so retain
// the exact object this module under test captured instead of stubbing whatever
// object happens to be on window by the time this suite runs.
const menuIpc = window.ipc;

type AddProseCompletion = DictionaryProviderIPCContract["add-prose-completion"];

interface AddProseCompletionMessage {
  command: "add-prose-completion";
  payload: AddProseCompletion["request"]["payload"];
}

describe("portable prose completion context action", function () {
  let invocations: Array<{ channel: string; message: AddProseCompletionMessage }>;
  let originalInvoke: typeof menuIpc.invoke;

  beforeEach(function () {
    originalInvoke = menuIpc.invoke;
    invocations = [];
    const invoke = async (
      channel: string,
      message: AddProseCompletionMessage,
    ): Promise<AddProseCompletion["response"]> => {
      invocations.push({ channel, message });
      return { added: true, filePath: "/portable/prose.txt" };
    };
    Object.defineProperty(menuIpc, "invoke", { configurable: true, writable: true, value: invoke });
  });

  const views: EditorView[] = [];

  afterEach(function () {
    menuIpc.invoke = originalInvoke;
    for (const view of views.splice(0)) {
      view.destroy();
    }
  });

  function viewFor(doc: string, anchor: number, head = anchor): EditorView {
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor, head },
        extensions: [markdownParser()],
      }),
    });
    views.push(view);
    return view;
  }

  it("adds a selected multi-word phrase when the menu is opened inside that selection", async function () {
    const doc = "Use on the other hand in this sentence.";
    const from = doc.indexOf("on the other hand");
    const to = from + "on the other hand".length;
    const view = viewFor(doc, from, to);
    const item = proseCompletionMenuItem(view, from + 4);
    assert.ok(item !== undefined && item.type === "normal");
    assert.strictEqual(item.label, "Add to prose completion dictionary");
    item.action?.();
    await Promise.resolve();
    assert.deepStrictEqual(invocations[0], {
      channel: "dictionary-provider",
      message: {
        command: "add-prose-completion",
        payload: { entry: "on the other hand" },
      },
    });
  });

  it("adds the clicked word instead of an unrelated selection elsewhere", async function () {
    const doc = "selected phrase and therefore here";
    const from = 0;
    const to = "selected phrase".length;
    const clicked = doc.indexOf("therefore") + 3;
    const view = viewFor(doc, from, to);
    const item = proseCompletionMenuItem(view, clicked);
    assert.ok(item !== undefined && item.type === "normal");
    item.action?.();
    await Promise.resolve();
    assert.strictEqual(invocations[0]?.message.payload.entry, "therefore");
  });
});
