import * as vscode from 'vscode';
import type { CounterStore } from './counterStore';
import { actionRows, type ActionRow } from './labels';

/** The sidebar tree: the action rows and the counter row. */
export class ActionsView implements vscode.TreeDataProvider<ActionRow>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ActionRow | undefined | null | void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: { dispose(): void };

  constructor(private readonly store: CounterStore) {
    this.subscription = store.onDidChange(() => {
      this.changed.fire();
    });
  }

  getChildren(element?: ActionRow): ActionRow[] {
    return element ? [] : actionRows(this.store.count);
  }

  getTreeItem(row: ActionRow): vscode.TreeItem {
    const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
    item.id = row.id;
    item.iconPath = new vscode.ThemeIcon(row.icon);
    if (row.command) {
      item.command = { command: row.command, title: row.label };
    }
    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}
