import * as vscode from 'vscode';
import { VIEW_TYPE } from './ids';
import { createNonce } from './nonce';
import { renderWindowHtml } from './windowHtml';
import {
  isWindowType,
  type PanelHandle,
  type VisibleTab,
  type WindowHost,
  type WindowPlace,
} from './windowController';

const TITLE = 'Demo Window';

function showOptions(place: WindowPlace): Parameters<typeof vscode.window.createWebviewPanel>[2] {
  switch (place) {
    case 'tab':
      return vscode.ViewColumn.Active;
    case 'beside':
      return vscode.ViewColumn.Beside;
    default:
      // Nobody asked for this window, and the user may be typing elsewhere.
      return { viewColumn: place.column, preserveFocus: true };
  }
}

function isWindowTab(tab: vscode.Tab): boolean {
  return tab.input instanceof vscode.TabInputWebview && isWindowType(tab.input.viewType);
}

async function closeTabs(tabs: vscode.Tab[]): Promise<void> {
  if (tabs.length > 0 && !(await vscode.window.tabGroups.close(tabs))) {
    throw new Error(`VS Code did not close ${tabs.length} old window tab(s)`);
  }
}

/** The VS Code side of the Demo window: creates panels and maps them to `PanelHandle`. */
export class VsCodeWindowHost implements WindowHost {
  constructor(private readonly extensionUri: vscode.Uri) {}

  create(place: WindowPlace): PanelHandle {
    return this.wrap(
      vscode.window.createWebviewPanel(VIEW_TYPE, TITLE, showOptions(place), this.webviewOptions()),
    );
  }

  /** Maps a panel that VS Code restored. */
  adopt(panel: vscode.WebviewPanel): PanelHandle {
    // The saved options hold the extension folder, which changes with a new version.
    panel.webview.options = this.webviewOptions();
    return this.wrap(panel);
  }

  async closeStaleTabs(): Promise<void> {
    await closeTabs(vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter(isWindowTab));
  }

  visibleTab(): VisibleTab | undefined {
    const tab = vscode.window.tabGroups.all
      .map((group) => group.activeTab)
      .find((active) => active !== undefined && isWindowTab(active));
    return (
      tab && {
        column: tab.group.viewColumn,
        close: () => closeTabs([tab]),
      }
    );
  }

  private webviewOptions(): vscode.WebviewOptions {
    return {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.extensionUri, 'media'),
      ],
    };
  }

  private wrap(panel: vscode.WebviewPanel): PanelHandle {
    const { webview } = panel;
    return {
      reveal: () => {
        // No column: it stays in its group. The `viewColumn` of a restored panel is wrong at first.
        panel.reveal();
      },
      dispose: () => {
        panel.dispose();
      },
      post: (message) => webview.postMessage(message),
      onMessage: (listener) => webview.onDidReceiveMessage(listener),
      onDispose: (listener) => panel.onDidDispose(listener),
      setHtml: () => {
        webview.html = renderWindowHtml({
          nonce: createNonce(),
          cspSource: webview.cspSource,
          scriptUri: this.resourceUri(webview, 'dist', 'webview.js'),
          styleUri: this.resourceUri(webview, 'media', 'window.css'),
        });
      },
    };
  }

  private resourceUri(webview: vscode.Webview, ...path: string[]): string {
    return webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...path)).toString();
  }
}
