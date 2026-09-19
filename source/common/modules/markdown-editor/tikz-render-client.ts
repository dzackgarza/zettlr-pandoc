/** Shared renderer-side TikZ request memo for widgets, lint, and preview consumers. */

import type { TikzRenderRequest, TikzRenderResult } from "source/app/util/tikz-render";

let renderMemo = new Map<string, Promise<TikzRenderResult>>();

export function __resetTikzRenderMemoForTests(): void {
  renderMemo = new Map();
}

export function requestTikzRender(request: TikzRenderRequest): Promise<TikzRenderResult> {
  const key = `${request.kind}\0${request.language}\0${request.docPath}\0${request.source}`;
  const memoized = renderMemo.get(key);
  if (memoized !== undefined) {
    return memoized;
  }

  const pending: Promise<TikzRenderResult> = window.ipc.invoke("application", {
    command: "tikz-render",
    payload: request,
  });
  renderMemo.set(key, pending);
  const clear = (): void => {
    if (renderMemo.get(key) === pending) {
      renderMemo.delete(key);
    }
  };
  void pending.then(clear, clear);
  return pending;
}
