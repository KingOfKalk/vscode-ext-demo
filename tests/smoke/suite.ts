// Runs in the extension host of a real VS Code, next to the installed .vsix. Bundled by run.mjs
// into the temporary directory of the run.
import assert from 'node:assert/strict';
import { renameSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as vscode from 'vscode';
import { VsCodeWindowHost } from '../../src/demoWindow';
import type { DemoApi } from '../../src/extension';
import { COMMANDS, CONFIG_SECTION, EXTENSION_ID, VIEW_ID, VIEW_TYPE } from '../../src/ids';
import { DEFAULT_MESSAGE } from '../../src/settings';
import { LOGS, problems, readLog, type CheckResult } from './results.mjs';
import { readScreen, type Page, type Screen } from './screen';

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

/** Waits until VS Code shows this. */
async function untilShown(expected: Partial<Screen>): Promise<void> {
  const keys = Object.keys(expected) as (keyof Screen)[];
  const end = Date.now() + 15_000;
  let shown: unknown;
  do {
    try {
      const screen = await within(5, 'reading the screen', readScreen(PROFILE));
      shown = Object.fromEntries(keys.map((key) => [key, screen[key]]));
      if (isDeepStrictEqual(shown, expected)) return;
    } catch (error) {
      // A page that comes or goes cannot be read.
      shown = error instanceof Error ? error.message : String(error);
    }
    await sleep(50);
  } while (Date.now() < end);
  assert.deepEqual(shown, expected);
}

/** The only window, with its style sheet. */
const windowWith = (message: string, count: number): { windows: Page[] } => ({
  windows: [{ message, count: String(count), cursor: 'pointer' }],
});

async function focusNote(): Promise<void> {
  const note = await vscode.workspace.openTextDocument(NOTE);
  await vscode.window.showTextDocument(note, { viewColumn: vscode.ViewColumn.One, preview: false });
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
  await focusNote();
  await execute(COMMANDS.openWindow);
  assert.equal((await onlyWindowTab()).group.viewColumn, vscode.ViewColumn.One);

  await setSetting('openLocation', 'beside');
  await execute(COMMANDS.openWindow);
  const tab = await onlyWindowTab();
  assert.equal(tab.group.viewColumn, vscode.ViewColumn.One, 'the open window moved');

  await closeTab(tab);
  await focusNote();
  await execute(COMMANDS.openWindow);
  assert.equal((await onlyWindowTab()).group.viewColumn, vscode.ViewColumn.Two);
}

/**
 * VS Code says column 1 for a window that it restored, wherever it is. The suite cannot restore
 * one, so a fake panel must do. This runs the code of `src/`, not of the .vsix.
 */
function revealAdopted(): Promise<void> {
  const calls: unknown[][] = [];
  const panel = {
    webview: {},
    viewColumn: vscode.ViewColumn.One,
    reveal: (...args: unknown[]) => void calls.push(args),
  } as unknown as vscode.WebviewPanel;
  new VsCodeWindowHost(extension().extensionUri).adopt(panel).reveal();
  assert.deepEqual(calls, [[]], 'the arguments of reveal()');
  return Promise.resolve();
}

async function pageRuns(): Promise<void> {
  const before = readyMessages();
  await execute(COMMANDS.openWindow);
  // Only the script of the page sends it: bundle, nonce, CSP and messages work.
  await until('the page of the window sends `ready`', () => readyMessages() > before);
  await onlyWindowTab();
  assert.equal(readyMessages(), before + 1, 'the page sent `ready` more than once');
}

/** Changes the count in every way and waits each time until it is shown. */
async function untilCountsShown(screen: (count: number) => Partial<Screen>): Promise<void> {
  await untilShown(screen(0));
  await setSetting('step', 5);
  for (const [command, count] of [
    [COMMANDS.increment, 5],
    [COMMANDS.increment, 10],
    [COMMANDS.decrement, 5],
    [COMMANDS.reset, 0],
  ] as const) {
    await execute(command);
    await untilShown(screen(count));
  }
}

async function windowShowsState(): Promise<void> {
  await execute(COMMANDS.openWindow);
  await untilCountsShown((count) => windowWith(DEFAULT_MESSAGE, count));
  await setSetting('message', 'Changed <b>message</b>');
  await untilShown(windowWith('Changed <b>message</b>', 0));
}

async function hiddenWindow(): Promise<void> {
  await execute(COMMANDS.openWindow);
  await untilShown(windowWith(DEFAULT_MESSAGE, 0));
  await focusNote();
  const hidden = () => windowTabs().every((tab) => !tab.isActive);
  await until('the window is behind the note', hidden);
  await setSetting('message', 'Changed while hidden');
  await execute(COMMANDS.increment);
  assert.ok(hidden(), 'the window came back on its own');
  // Not with Open Window, which the extension notices: users switch tabs.
  await execute('workbench.action.previousEditor');
  await until('the window is back', () => !hidden());
  await untilShown(windowWith('Changed while hidden', 1));
  await execute(COMMANDS.decrement);
  await untilShown(windowWith('Changed while hidden', 0));
}

async function statusBar(): Promise<void> {
  await untilCountsShown((count) => ({ statusBar: [`Demo: ${count}`] }));
  assert.equal(extension().exports.statusBar.command, COMMANDS.openWindow);
}

async function sidebar(): Promise<void> {
  await execute(`${VIEW_ID}.focus`);
  await untilCountsShown((count) => ({
    sidebar: ['Open window', 'Say hello', 'Show log', `Counter: ${count}`],
  }));
  const view = extension().exports.sidebar;
  assert.deepEqual(
    view.getChildren().map((row) => view.getTreeItem(row).command?.command),
    [COMMANDS.openWindow, COMMANDS.sayHello, COMMANDS.showLog, undefined],
  );
}

async function deadWindow(): Promise<void> {
  await focusNote();
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

async function decrement(): Promise<void> {
  await setSetting('step', 5);
  await execute(COMMANDS.increment);
  await setSetting('step', 3);
  for (const expected of [2, 0, 0]) {
    const lines = demoLog().length;
    await execute(COMMANDS.decrement);
    assert.equal(getCount(), expected);
    await until(`the decrement to ${expected} is in the Demo log`, () =>
      demoLog().slice(lines).includes(`Count changed: ${expected}`),
    );
  }
  assert.deepEqual(problems(demoLog()), [], 'problems in the Demo log');
}

async function otherCommands(): Promise<void> {
  await setSetting('message', 'Hello from the smoke test');
  await execute(COMMANDS.sayHello);
  await untilShown({ notifications: ['Hello from the smoke test'] });
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
  await untilShown({ statusBar: [] });
  await setSetting('showStatusBar', true);
  await untilShown({ statusBar: ['Demo: 0'] });
  // The live session waits for this line.
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
  ['reveals an adopted panel without naming a column', revealAdopted],
  ['runs the page of the window', pageRuns],
  ['shows the count and the message in the window', windowShowsState],
  ['shows in the window what changed while it was hidden', hiddenWindow],
  ['shows the count in the status bar', statusBar],
  ['shows the rows and the count in the sidebar', sidebar],
  ['replaces a window that nobody owns', deadWindow],
  ['increments after the window was closed', incrementAfterClose],
  ['adds the step, limits it and resets', step],
  ['decrements by the step, never below 0', decrement],
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
