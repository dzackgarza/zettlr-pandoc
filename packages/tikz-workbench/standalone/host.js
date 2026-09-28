globalThis.tikzWorkbenchHost = {
  editorUrl: '/tikz-editor/index.html',
  quiverUrl: '/quiver/zettlr-host.html',
  imageBaseUrl: new URL('/tikz-image/', location.href).href,
  async load() {
    const response = await fetch('/api/document');
    if (!response.ok) throw new Error(await response.text());
    return { source: await response.text(), revision: response.headers.get('etag') };
  },
  async compile(source) {
    const response = await fetch('/api/render', { method: 'POST', body: source });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  },
  async save(source, revision) {
    const response = await fetch('/api/document', {
      method: 'PUT', headers: { 'if-match': revision }, body: source
    });
    if (!response.ok) throw new Error(await response.text());
    return response.headers.get('etag');
  },
  async quiverMacros() {
    const response = await fetch('/api/quiver-macros');
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }
};
