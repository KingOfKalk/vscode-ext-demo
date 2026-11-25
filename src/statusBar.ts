import * as vscode from 'vscode';
import type { CounterStore } from './counterStore';
import { COMMANDS, STATUS_BAR_ID } from './ids';
import { STATUS_BAR_TOOLTIP, statusBarText } from './labels';

/** The count in the status bar. A click opens the window. */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscription: { dispose(): void };

  constructor(store: CounterStore) {
    this.item = vscode.window.createStatusBarItem(STATUS_BAR_ID, vscode.StatusBarAlignment.Left, 0);
    this.item.name = 'Demo';
    this.item.command = COMMANDS.openWindow;
    this.item.tooltip = STATUS_BAR_TOOLTIP;
    this.item.text = statusBarText(store.count);
    this.subscription = store.onDidChange((count) => {
      this.item.text = statusBarText(count);
    });
  }

  /** What a click runs. */
  get command(): vscode.StatusBarItem['command'] {
    return this.item.command;
  }

  setVisible(visible: boolean): void {
    if (visible) {
      this.item.show();
    } else {
      this.item.hide();
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}
