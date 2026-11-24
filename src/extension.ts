import * as vscode from 'vscode';
import { ActionsView } from './actionsView';
import { guarded } from './counterActions';
import { CounterStore } from './counterStore';
import { DemoWindow } from './demoWindow';
import { describeError } from './describe';
import { COMMANDS, CONFIG_SECTION, EXTENSION_ID, VIEW_ID, VIEW_TYPE } from './ids';
import { readSettings, type Settings } from './settings';
import { StatusBar } from './statusBar';

/** What `activate()` returns; the smoke tests read the count through it. */
export interface DemoApi {
  getCount(): number;
}

export function activate(context: vscode.ExtensionContext): DemoApi {
  const log = vscode.window.createOutputChannel('Demo', { log: true });
  context.subscriptions.push(log);

  const getSettings = (): Settings =>
    readSettings((key) => vscode.workspace.getConfiguration(CONFIG_SECTION).get(key));

  const reportError = (what: string, error: unknown): void => {
    log.error(`Could not ${what}: ${describeError(error)}`);
    void vscode.window.showErrorMessage(`Demo: could not ${what}. See the Demo log for details.`);
  };

  const store = new CounterStore(context.workspaceState, () => getSettings().step);
  context.subscriptions.push(
    store.onDidChange((count) => {
      log.info(`Count changed: ${count}`);
    }),
  );

  const demoWindow = new DemoWindow({
    extensionUri: context.extensionUri,
    store,
    log,
    getSettings,
    onError: reportError,
  });
  const statusBar = new StatusBar(store);
  const actionsView = new ActionsView(store);
  statusBar.setVisible(getSettings().showStatusBar);

  context.subscriptions.push(
    demoWindow,
    statusBar,
    actionsView,
    vscode.window.registerTreeDataProvider(VIEW_ID, actionsView),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: (panel) => {
        demoWindow.restore(panel);
        return Promise.resolve();
      },
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(CONFIG_SECTION)) {
        return;
      }
      const settings = getSettings();
      log.info(`Settings changed: ${JSON.stringify(settings)}`);
      statusBar.setVisible(settings.showStatusBar);
      demoWindow.refresh();
    }),
    vscode.commands.registerCommand(COMMANDS.openWindow, () => {
      demoWindow.open();
    }),
    vscode.commands.registerCommand(COMMANDS.sayHello, () => {
      // Not returned: the command must not wait until the notification is closed.
      void vscode.window.showInformationMessage(getSettings().message);
    }),
    vscode.commands.registerCommand(COMMANDS.increment, () =>
      guarded('increment the counter', () => store.increment(), reportError),
    ),
    vscode.commands.registerCommand(COMMANDS.reset, () =>
      guarded('reset the counter', () => store.reset(), reportError),
    ),
    vscode.commands.registerCommand(COMMANDS.showLog, () => {
      log.show();
    }),
    vscode.commands.registerCommand(COMMANDS.openSettings, () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXTENSION_ID}`),
    ),
  );

  log.info(`Extension activated, count ${store.count}`);
  return { getCount: () => store.count };
}
