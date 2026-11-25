// Runs in the extension host of a real VS Code, next to the installed .vsix. Bundled by run.mjs
// into the temporary directory of the run.
import assert from 'node:assert/strict';
import { renameSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import * as vscode from 'vscode';
import type { DemoApi } from '../../src/extension';
import { COMMANDS, CONFIG_SECTION, EXTENSION_ID, VIEW_TYPE } from '../../src/ids';
import { LOGS, problems, readLog, type CheckResult } from './results.mjs';

/** The suite is in `driver/` of the directory that run.mjs made for this run. */
const DIR = dirname(__dirname);
const EXTENSIONS = join(DIR, 'extensions');
const PROFILE = join(DIR, 'profile');
const NOTE = vscode.Uri.file(join(DIR, 'workspace', 'note.txt'));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Rejects if `action` does not finish in time. */
async function within<T>(seconds: number, what: string, action: PromiseLike<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} did not finish within ${seconds} s`));
    }, seconds * 1000);
  });
  try {
    return await Promise.race([action, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(what: string, condition: () => boolean, seconds = 15): Promise<void> {
  const end = Date.now() + seconds * 1000;
  while (!condition()) {
    if (Date.now() > end) {
      throw new Error(`waited ${seconds} s, but this did not happen: ${what}`);
    }
    await sleep(50);
  }
}

const execute = (command: string) =>
  within(10, `the command ${command}`, vscode.commands.executeCommand(command));

function extension(): vscode.Extension<DemoApi> {
  const found = vscode.extensions.getExtension<DemoApi>(EXTENSION_ID);
  assert.ok(found, `${EXTENSION_ID} is not installed`);
  return found;
}

const getCount = () => extension().exports.getCount();
const demoLog = () => readLog(PROFILE, LOGS.demo);
const readyMessages = () => demoLog().split('Webview message: ready').length - 1;

function windowTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) =>
        tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(VIEW_TYPE),
    );
}

/** The only tab of the Demo window. The wait gives a second one the time to show up. */
async function onlyWindowTab(): Promise<vscode.Tab> {
  await until('a tab with the Demo window', () => windowTabs().length > 0);
  await sleep(500);
  const [tab, ...more] = windowTabs();
  assert.ok(tab);
  assert.equal(more.length, 0, `there are ${more.length + 1} Demo windows`);
  return tab;
}

async function closeTab(tab: vscode.Tab): Promise<void> {
  assert.ok(await vscode.window.tabGroups.close(tab), 'the tab was not closed');
  await until('the Demo window is closed', () => windowTabs().length === 0);
}

async function setSetting(key: string, value: unknown): Promise<void> {
  const read = () => vscode.workspace.getConfiguration(CONFIG_SECTION).inspect(key)?.globalValue;
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update(key, value, vscode.ConfigurationTarget.Global);
  await until(`the setting ${key} is ${JSON.stringify(value)}`, () => read() === value);
}

/** Later checks start without editors, with default settings and the count 0. */
async function prepare(): Promise<void> {
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await until('all editors are closed', () =>
    vscode.window.tabGroups.all.every((group) => group.tabs.length === 0),
  );
  for (const key of ['message', 'step', 'showStatusBar', 'openLocation']) {
    await setSetting(key, undefined);
  }
  await execute(COMMANDS.reset);
  assert.equal(getCount(), 0);
}

async function activation(): Promise<void> {
  // Never calls activate(): `onStartupFinished` must do it.
  await until(`${EXTENSION_ID} activates on its own`, () => extension().isActive, 60);
  const path = extension().extensionPath;
  assert.ok(path.startsWith(EXTENSIONS + sep), `${path} is not in ${EXTENSIONS}`);
  assert.equal(getCount(), 0);
  await until('the activation is in the Demo log', () =>
    demoLog().includes('Extension activated, count 0'),
  );
}

async function commandsRegistered(): Promise<void> {
  const registered = await vscode.commands.getCommands(true);
  const missing = Object.values(COMMANDS).filter((id) => !registered.includes(id));
  assert.deepEqual(missing, [], 'commands that are not registered');
}

async function oneWindow(): Promise<void> {
  await Promise.all([execute(COMMANDS.openWindow), execute(COMMANDS.openWindow)]);
  await onlyWindowTab();
  await execute(COMMANDS.openWindow);
  await onlyWindowTab();
}

async function openLocation(): Promise<void> {
  const note = await vscode.workspace.openTextDocument(NOTE);
  await vscode.window.showTextDocument(note, { viewColumn: vscode.ViewColumn.One, preview: false });
  await execute(COMMANDS.openWindow);
  assert.equal((await onlyWindowTab()).group.viewColumn, vscode.ViewColumn.One);

  await setSetting('openLocation', 'beside');
  await execute(COMMANDS.openWindow);
  const tab = await onlyWindowTab();
  assert.equal(tab.group.viewColumn, vscode.ViewColumn.One, 'the open window moved');

  await closeTab(tab);
  await vscode.window.showTextDocument(note, { viewColumn: vscode.ViewColumn.One });
  await execute(COMMANDS.openWindow);
  assert.equal((await onlyWindowTab()).group.viewColumn, vscode.ViewColumn.Two);
}

async function pageRuns(): Promise<void> {
  const before = readyMessages();
  await execute(COMMANDS.openWindow);
  // Only the script of the page sends it: bundle, nonce, CSP and messages work.
  await until('the page of the window sends `ready`', () => readyMessages() > before);
  await onlyWindowTab();
  assert.equal(readyMessages(), before + 1, 'the page sent `ready` more than once');
}

async function deadWindow(): Promise<void> {
  const note = await vscode.workspace.openTextDocument(NOTE);
  await vscode.window.showTextDocument(note, { viewColumn: vscode.ViewColumn.One, preview: false });
  const before = readyMessages();
  const lines = demoLog().length;
  // The extension does not own it, like a window that is still there after a restart of the
  // extension host. The suite cannot restart its own host.
  const dead = vscode.window.createWebviewPanel(VIEW_TYPE, 'Dead Window', {
    viewColumn: vscode.ViewColumn.Two,
    preserveFocus: true,
  });
  let closed = false;
  dead.onDidDispose(() => {
    closed = true;
  });
  await until('the dead window is closed', () => closed);
  await until('the page of the new window sends `ready`', () => readyMessages() > before);
  const tab = await onlyWindowTab();
  assert.equal(tab.group.viewColumn, vscode.ViewColumn.Two, 'the window is in another group');
  const { activeTabGroup } = vscode.window.tabGroups;
  assert.equal(activeTabGroup.viewColumn, vscode.ViewColumn.One, 'the window took the focus');
  assert.equal(readyMessages(), before + 1, 'more than one page sent `ready`');
  assert.deepEqual(problems(demoLog().slice(lines)), [], 'problems in the Demo log');
}

async function incrementAfterClose(): Promise<void> {
  const before = readyMessages();
  await execute(COMMANDS.openWindow);
  await until('the page of the window sends `ready`', () => readyMessages() > before);
  await closeTab(await onlyWindowTab());
  const lines = demoLog().length;
  await execute(COMMANDS.increment);
  assert.equal(getCount(), 1);
  await until('the increment is in the Demo log', () =>
    demoLog().slice(lines).includes('Count changed: 1'),
  );
  assert.deepEqual(problems(demoLog()), [], 'problems in the Demo log');
}

async function step(): Promise<void> {
  for (const [value, added] of [
    [undefined, 1],
    [5, 5],
    [500, 100],
    ['x', 1],
  ] as const) {
    await setSetting('step', value);
    const before = getCount();
    await execute(COMMANDS.increment);
    assert.equal(getCount() - before, added, `added with step ${JSON.stringify(value)}`);
  }
  await execute(COMMANDS.reset);
  assert.equal(getCount(), 0);
}

async function otherCommands(): Promise<void> {
  await execute(COMMANDS.sayHello);
  await execute(COMMANDS.showLog);
  await until('the Demo log is visible', () =>
    vscode.window.visibleTextEditors.some(
      ({ document }) => document.uri.scheme === 'output' && document.uri.path.includes('Demo'),
    ),
  );
  await execute(COMMANDS.openSettings);
  await until(
    'the settings editor is open',
    () => vscode.window.tabGroups.activeTabGroup.activeTab?.label === 'Settings',
  );
}

async function settingsChange(): Promise<void> {
  const lines = demoLog().length;
  await setSetting('showStatusBar', false);
  await until('the changed setting is in the Demo log', () =>
    /Settings changed: .*"showStatusBar":false/.test(demoLog().slice(lines)),
  );
  assert.deepEqual(problems(demoLog()), [], 'problems in the Demo log');
}

const CHECKS: [name: string, check: () => Promise<void>][] = [
  ['is installed from the .vsix and activates on its own', activation],
  ['registers all commands', commandsRegistered],
  ['opens one window, also for quick calls', oneWindow],
  ['opens the window where openLocation says', openLocation],
  ['runs the page of the window', pageRuns],
  ['replaces a window that nobody owns', deadWindow],
  ['increments after the window was closed', incrementAfterClose],
  ['adds the step, limits it and resets', step],
  ['says hello, shows the log, opens the settings', otherCommands],
  ['applies a changed setting', settingsChange],
];

/** Called by VS Code. The results go to a file, also while a check hangs. */
export async function run(): Promise<void> {
  const results = CHECKS.map(([name]): CheckResult => ({ name, status: 'pending' }));
  const save = () => {
    const file = join(DIR, 'results.json');
    // Renamed: a VS Code that ends in between never leaves half a file.
    writeFileSync(`${file}.part`, JSON.stringify(results));
    renameSync(`${file}.part`, file);
  };
  for (const [index, [name, check]] of CHECKS.entries()) {
    results[index] = { name, status: 'running' };
    save();
    try {
      if (index > 1) await within(30, 'the preparation', prepare());
      await within(90, 'the check', check());
      results[index] = { name, status: 'passed' };
    } catch (error) {
      const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
      results[index] = { name, status: 'failed', error: text };
      // Without the extension the others can only fail, too.
      if (index === 0) break;
    } finally {
      save();
    }
  }
  // VS Code logs an unhandled rejection only after a second.
  await sleep(2000);
  if (results.some(({ status }) => status !== 'passed')) {
    throw new Error('not all checks passed');
  }
}
