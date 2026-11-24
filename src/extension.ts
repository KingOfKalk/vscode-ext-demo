import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Demo', { log: true });
  context.subscriptions.push(log);
  log.info('Extension activated');
}
