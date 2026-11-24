import * as vscode from 'vscode';
import type { ReportError } from './counterActions';
import type { CounterStore } from './counterStore';
import { describeError } from './describe';
import { VIEW_TYPE } from './ids';
import { createNonce } from './nonce';
import type { ToWebview } from './protocol';
import type { Settings } from './settings';
import { renderWindowHtml } from './windowHtml';
import { buildState, handleWebviewMessage, type MessageLog } from './windowMessages';

export interface DemoWindowDeps {
  extensionUri: vscode.Uri;
  store: CounterStore;
  log: MessageLog;
  getSettings: () => Settings;
  onError: ReportError;
}

/**
 * The Demo window: one editor tab (a webview panel) at most. It only displays the store.
 * A new panel and a panel restored after a reload get the same wiring.
 */
export class DemoWindow implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  /** Sends the current state to the open window. */
  private send: (() => void) | undefined;
  /** Releases the listeners of the open window. */
  private release: (() => void) | undefined;

  constructor(private readonly deps: DemoWindowDeps) {}

  /** Shows the window; reveals it if it is already open. */
  open(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const column =
      this.deps.getSettings().openLocation === 'beside'
        ? vscode.ViewColumn.Beside
        : vscode.ViewColumn.Active;
    this.attach(
      vscode.window.createWebviewPanel(VIEW_TYPE, 'Demo Window', column, this.webviewOptions()),
    );
  }

  /** Takes over a panel that VS Code restored. Only one window may exist. */
  restore(panel: vscode.WebviewPanel): void {
    if (this.panel) {
      this.deps.log.info('Window already open; closing the restored one');
      panel.dispose();
      this.panel.reveal();
      return;
    }
    // The options are not saved with the panel.
    panel.webview.options = this.webviewOptions();
    this.attach(panel);
  }

  /** Sends the state again, for example after the `message` setting changed. */
  refresh(): void {
    this.send?.();
  }

  /**
   * Stops listening to the store. The panel itself stays: closing it on shutdown would keep it
   * from coming back after a reload.
   */
  dispose(): void {
    this.release?.();
  }

  private webviewOptions(): vscode.WebviewOptions {
    const root = this.deps.extensionUri;
    return {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(root, 'dist'), vscode.Uri.joinPath(root, 'media')],
    };
  }

  private attach(panel: vscode.WebviewPanel): void {
    const { store, log, getSettings, onError } = this.deps;
    let disposed = false;

    const post = (message: ToWebview): void => {
      if (disposed) {
        return;
      }
      void panel.webview.postMessage(message).then(undefined, (error: unknown) => {
        log.warn(`Could not post to the window: ${describeError(error)}`);
      });
    };
    const send = (): void => {
      post(buildState(store.count, getSettings().message));
    };

    // The handler is in place before the page exists, so its `ready` is never missed.
    const subscriptions: { dispose(): void }[] = [
      panel.webview.onDidReceiveMessage((raw: unknown) => {
        void handleWebviewMessage(raw, {
          store,
          message: () => getSettings().message,
          post,
          log,
          onError,
        });
      }),
      store.onDidChange(send),
    ];
    const release = (): void => {
      disposed = true;
      for (const subscription of subscriptions.splice(0)) {
        subscription.dispose();
      }
    };
    subscriptions.push(
      panel.onDidDispose(() => {
        release();
        this.panel = undefined;
        this.send = undefined;
        this.release = undefined;
      }),
    );

    this.panel = panel;
    this.send = send;
    this.release = release;

    const { webview } = panel;
    const root = this.deps.extensionUri;
    webview.html = renderWindowHtml({
      nonce: createNonce(),
      cspSource: webview.cspSource,
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(root, 'dist', 'webview.js')).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(root, 'media', 'window.css')).toString(),
    });
  }
}
