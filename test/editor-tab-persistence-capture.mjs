import { readFile } from "node:fs/promises";
import { openScene, outputDirectory } from "./visual/scene.mjs";

const config = JSON.parse(
  await readFile(new URL("./fixtures/editor-config.json", import.meta.url), "utf8"),
);
config.app.openFiles = [];
config.app.openWorkspaces = [];
config.openDirectory = null;
config.tikz = { dataDir: "", figuresDir: "" };
config.references = { authorityReportDebounceMs: 500 };
config.editor.autocompleteSuggestEmojis = false;
config.editor.autocompleteWithEnter = false;
config.editor.autocompleteWithTab = true;
config.editor.snippetsFile = "";
config.editor.proseCompletionFile = "";
config.editor.proseCompletionExtraFiles = [];
config.editor.quickTexFile = "";
config.editor.quickTexPluginDirectory = "";
config.editor.navigationShortcuts = undefined;
config.editor.showStatusbar = undefined;
config.editor.showFormattingToolbar = undefined;
config.window.recentGlobalSearches = [];
config.shortcuts = config.shortcuts ?? { editor: {}, ui: {} };
config.shortcuts.editor = config.shortcuts.editor ?? {};
config.shortcuts.ui = config.shortcuts.ui ?? {};

const A = "/tmp/tab-persistence-a.md";
const B = "/tmp/tab-persistence-b.md";
const contents = {
  [A]: "# Alpha\n\n" + Array.from({ length: 120 }, (_, i) => `Alpha line ${i}`).join("\n"),
  [B]: "# Beta\n\n" + Array.from({ length: 120 }, (_, i) => `Beta line ${i}`).join("\n"),
};

function emptyReferences(path) {
  return {
    documentPath: path,
    sourceHash: "",
    definitions: [],
    occurrences: [],
    citations: [],
  };
}

function descriptor(path) {
  const name = path.split("/").at(-1);
  const text = contents[path];
  return {
    path,
    dir: "/tmp",
    name,
    type: "file",
    size: text.length,
    modtime: 0,
    creationtime: 0,
    ext: ".md",
    id: "",
    tags: [],
    links: [],
    citekeys: [],
    bom: "",
    wordCount: text.split(/\s+/u).length,
    charCount: text.length,
    firstHeading: path === A ? "Alpha" : "Beta",
    yamlTitle: undefined,
    frontmatter: null,
    linefeed: "\n",
    references: emptyReferences(path),
  };
}

const descriptors = new Map([
  [A, descriptor(A)],
  [B, descriptor(B)],
]);
const tree = {
  type: "leaf",
  id: "probe-leaf",
  openFiles: [
    { path: A, pinned: false },
    { path: B, pinned: false },
  ],
  activeFile: { path: A, pinned: false },
};
const fetchCounts = { [A]: 0, [B]: 0 };

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body, #window-content, #app { margin: 0; width: 100%; height: 100%; overflow: hidden; }
  .editor-pane { width: 100%; height: 100%; }
  .editor-container { height: calc(100% - 36px); }
  .main-editor-wrapper { height: 100%; }
  .cm-editor { height: 100%; }
</style></head><body><div id="window-content"><div id="app"></div></div><script>
  window.path = {
    basename: path => path.split('/').pop(),
    dirname: path => path.slice(0, path.lastIndexOf('/')) || '/',
    extname: path => { const name = path.split('/').pop(); const dot = name.lastIndexOf('.'); return dot < 0 ? '' : name.slice(dot); },
    isAbsolute: path => path.startsWith('/'),
    join: (...parts) => parts.join('/').replace(/\\/{2,}/g, '/'),
    resolve: (...parts) => parts.join('/').replace(/\\/{2,}/g, '/'),
  };
  window.__TAB_CONFIG = ${JSON.stringify(config)};
  window.__TAB_TREE = ${JSON.stringify(tree)};
  window.__TAB_CONTENTS = ${JSON.stringify(contents)};
  window.__tabProbeFetchCounts = ${JSON.stringify(fetchCounts)};
  window.config = {
    get(key) {
      if (key === undefined) return window.__TAB_CONFIG;
      return key.split('.').reduce((value, segment) => value?.[segment], window.__TAB_CONFIG);
    },
    set() {},
  };
  const listeners = new Map();
  window.__tabProbeEmit = (channel, ...args) => {
    for (const listener of listeners.get(channel) ?? []) listener({}, ...args);
  };
  const clone = value => structuredClone(value);
  const getDescriptor = payload => {
    if (Array.isArray(payload)) return payload.map(path => ${JSON.stringify([...descriptors.values()])}.find(d => d.path === path)).filter(Boolean);
    return ${JSON.stringify([...descriptors.values()])}.find(d => d.path === payload);
  };
  window.ipc = {
    on(channel, listener) {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener); listeners.set(channel, set);
      return () => set.delete(listener);
    },
    send() {},
    sendSync(channel, message) {
      if (channel === 'config-provider' && message?.command === 'get-config') return window.__TAB_CONFIG;
      if (channel === 'config-provider' && message?.command === 'set-config-single') return true;
      return undefined;
    },
    async invoke(channel, message) {
      const command = message?.command;
      const payload = message?.payload;
      if (channel === 'documents-provider' && command === 'retrieve-tab-config') return clone(window.__TAB_TREE);
      if (channel === 'documents-provider' && command === 'get-file-modification-status') return [];
      if (channel === 'documents-provider' && command === 'get-collaboration-session') return undefined;
      if (channel === 'documents-provider' && command === 'open-file') {
        const file = window.__TAB_TREE.openFiles.find(entry => entry.path === payload.path);
        window.__TAB_TREE.activeFile = file;
        window.__tabProbeEmit('documents-update', { event: 'active-file-changed', context: { windowId: payload.windowId, leafId: payload.leafId, filePath: payload.path } });
        return true;
      }
      if (channel === 'documents-provider' && command === 'focus-leaf') return undefined;
      if (channel === 'documents-authority' && command === 'get-document') {
        window.__tabProbeFetchCounts[payload.filePath]++;
        return { content: window.__TAB_CONTENTS[payload.filePath], type: 1, startVersion: 0 };
      }
      if (channel === 'documents-authority' && command === 'pull-updates') return await new Promise(() => {});
      if (channel === 'documents-authority' && command === 'push-updates') return true;
      if (channel === 'fsal' && command === 'read-path-recursively') return [];
      if (channel === 'fsal' && command === 'get-descriptor') return clone(getDescriptor(payload));
      if (channel === 'tag-provider') return [];
      if (channel === 'assets-provider' && command === 'list-snippets') return { snippets: [], diagnostics: [], sourceFile: '' };
      if (channel === 'assets-provider' && command === 'get-quicktex') return { prose: {}, math: {}, excludeChars: ['{','(','['], sourceFile: '', diagnostics: [] };
      if (channel === 'link-provider' && command === 'get-link-database') return {};
      if (channel === 'citeproc-provider' && command === 'get-items') return [];
      if (channel === 'reference-provider' && command === 'get-snapshot') return { snapshots: [], resolutions: new Map() };
      if (channel === 'flowmark-lint') return { ok: true, diagnostics: [] };
      return undefined;
    }
  };
</script><script src="./editor-tab-persistence-bundle.js"></script></body></html>`;

const scene = await openScene({
  width: 1100,
  height: 760,
  args: ["--ozone-platform=x11", "--disable-gpu"],
});
try {
  scene.page.on("pageerror", (error) => {
    console.error("[tab-persistence pageerror]", error);
  });
  scene.page.on("console", (message) => {
    if (message.type() === "error") console.error("[tab-persistence console]", message.text());
  });
  await scene.open("editor-tab-persistence.html", html, { window_id: "probe-window" });
  try {
    await scene.page.evaluate(() => window.tabPersistenceReady);
  } catch (error) {
    const diagnostics = await scene.page.evaluate(() => ({
      body: document.body.innerText,
      tabs: Array.from(document.querySelectorAll("[data-path]")).map((node) => ({
        path: node.getAttribute("data-path"),
        className: node.className,
      })),
      editors: document.querySelectorAll(".cm-editor").length,
      wrappers: Array.from(document.querySelectorAll(".main-editor-wrapper")).map((node) => ({
        display: getComputedStyle(node).display,
        text: node.textContent,
      })),
      fetchCounts: window.__tabProbeFetchCounts,
      tree: window.__TAB_TREE,
    }));
    console.error("[tab-persistence diagnostics]", JSON.stringify(diagnostics, null, 2));
    throw error;
  }

  const initial = await scene.page.evaluate(() => {
    const wrapper = Array.from(document.querySelectorAll(".main-editor-wrapper")).find(
      (el) => getComputedStyle(el).display !== "none",
    );
    const editor = wrapper?.querySelector(".cm-editor");
    const scroller = wrapper?.querySelector(".cm-scroller");
    editor.dataset.tabPersistenceProbe = "alpha-editor";
    scroller.scrollTop = 600;
    return window.tabPersistenceState();
  });

  await scene.page.evaluate(() => window.tabPersistenceNext());
  await scene.page.waitForFunction(
    (path) =>
      window.tabPersistenceState().activePath === path &&
      window.tabPersistenceState().fetchCounts[path] === 1,
    B,
  );
  await scene.page.evaluate(() => window.tabPersistencePrevious());
  await scene.page.waitForFunction((path) => window.tabPersistenceState().activePath === path, A);
  await scene.page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const restored = await scene.page.evaluate(() => window.tabPersistenceState());

  if (initial.fetchCounts[A] !== 1 || restored.fetchCounts[A] !== 1) {
    throw new Error(
      `Tab A was refetched instead of retained: ${JSON.stringify({ initial, restored })}`,
    );
  }
  if (restored.activeEditorProbeId !== "alpha-editor") {
    throw new Error(
      `Tab A returned with a different CodeMirror DOM node: ${JSON.stringify(restored)}`,
    );
  }
  if (Math.abs((restored.activeScrollTop ?? 0) - 600) > 2) {
    throw new Error(`Tab A lost its viewport: ${JSON.stringify(restored)}`);
  }
  if (restored.editorCount !== 2) {
    throw new Error(
      `Both initialized tab editors should remain alive: ${JSON.stringify(restored)}`,
    );
  }

  console.log(JSON.stringify({ initial, restored }, null, 2));
} finally {
  await scene.close();
}
