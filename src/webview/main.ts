import { parseToWebview, type ToExtension } from '../protocol';

/** The part of the object from `acquireVsCodeApi()` that this window uses. */
export interface VsCodeApi {
  postMessage(message: ToExtension): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

function requireElement(doc: Document, id: string): HTMLElement {
  const element = doc.getElementById(id);
  if (!element) {
    throw new Error(`Element #${id} is missing`);
  }
  return element;
}

/**
 * Wires the window: buttons post messages, `state` messages are shown.
 * The window never counts; it shows what the extension says and ignores anything malformed.
 */
export function initWindow(doc: Document, api: VsCodeApi): void {
  const message = requireElement(doc, 'message');
  const count = requireElement(doc, 'count');
  const increment = requireElement(doc, 'increment');
  const decrement = requireElement(doc, 'decrement');
  const reset = requireElement(doc, 'reset');

  increment.addEventListener('click', () => {
    api.postMessage({ type: 'increment' });
  });
  decrement.addEventListener('click', () => {
    api.postMessage({ type: 'decrement' });
  });
  reset.addEventListener('click', () => {
    api.postMessage({ type: 'reset' });
  });

  doc.defaultView?.addEventListener('message', (event: MessageEvent<unknown>) => {
    const state = parseToWebview(event.data);
    if (!state) {
      return;
    }
    // Only when it changed: a screen reader announces every rewrite of the text, even of the same.
    if (message.textContent !== state.message) {
      message.textContent = state.message;
    }
    count.textContent = String(state.count);
  });

  api.postMessage({ type: 'ready' });
}

// In the webview bundle the VS Code API exists; tests import this file without it.
if (typeof acquireVsCodeApi === 'function') {
  initWindow(document, acquireVsCodeApi());
}
