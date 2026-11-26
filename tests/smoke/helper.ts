// The restart stage of the smoke tests: runs in the extension host of a normal VS Code start (not
// in test mode, where VS Code keeps its storage in memory), next to the installed .vsix. Bundled by
// run.mjs, which writes the phase to `phase.json` next to the bundle before each start. Does what
// the phase says with commands only, writes what VS Code showed to `<phase>.json` and quits VS Code.
// It never clicks. restart.mjs knows what each phase must show.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as vscode from 'vscode';
import type { DemoApi } from '../../src/extension';
import { COMMANDS, EXTENSION_ID, VIEW_TYPE } from '../../src/ids';
import { DEFAULT_MESSAGE } from '../../src/settings';
import { readScreen, type Page } from './screen';

export interface Phase {
  name: 'count' | 'restore' | 'hidden' | 'other';
  profile: string;
  count: number;
}

/** What VS Code showed. */
export interface Report {
  /** The count of the extension. */
  count?: number;
  /** In `hidden`: whether the restored window was a tab behind another one. */
  restoredHidden?: boolean;
  /** At the end: the pages of the window, or why they could not be read. */
  windows?: Page[] | string;
  /** At the end: the tabs of the window. */
  tabs?: number;
  error?: string;
}

const DIR = dirname(__dirname);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(what: string, condition: () => boolean, seconds = 20): Promise<void> {
  const end = Date.now() + seconds * 1000;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`waited ${seconds} s, but this did not happen: ${what}`);
    await sleep(50);
  }
}

const demo = () => vscode.extensions.getExtension<DemoApi>(EXTENSION_ID);

const windowTabs = () =>
  vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) =>
        tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(VIEW_TYPE),
    );

const hidden = () => windowTabs().every((tab) => !tab.isActive);

async function windows(profile: string): Promise<Page[] | string> {
  try {
    return (await readScreen(profile)).windows;
  } catch (error) {
    // A page that comes or goes cannot be read.
    return error instanceof Error ? error.message : String(error);
  }
}

/** Waits until VS Code shows these pages; returns what it showed last. */
async function untilShown(profile: string, expected: Page[]): Promise<Page[] | string> {
  const end = Date.now() + 20_000;
  let shown = await windows(profile);
  while (!isDeepStrictEqual(shown, expected) && Date.now() < end) {
    await sleep(50);
    shown = await windows(profile);
  }
  return shown;
}

/** Hides the window behind a file of the folder, as a user who opens a file does. */
async function hide(): Promise<void> {
  const [folder] = vscode.workspace.workspaceFolders ?? [];
  if (!folder) throw new Error('no folder is open');
  const note = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, 'note.txt'));
  await vscode.window.showTextDocument(note, { viewColumn: vscode.ViewColumn.One, preview: false });
  await until('the window is behind the note', hidden);
}

async function runPhase({ name, profile, count }: Phase, report: Report): Promise<void> {
  // Never activates it: `onStartupFinished` or the restored window must.
  await until(`${EXTENSION_ID} is active`, () => demo()?.isActive === true, 60);
  report.count = demo()?.exports.getCount();
  if (name === 'count') {
    await vscode.commands.executeCommand(COMMANDS.openWindow);
    for (let i = 0; i < count; i++) await vscode.commands.executeCommand(COMMANDS.increment);
    report.count = demo()?.exports.getCount();
  }
  if (name === 'hidden') {
    await until('VS Code restored the tab of the window', () => windowTabs().length > 0);
    report.restoredHidden = windowTabs().length === 1 && hidden();
    // Not with Open Window, which the extension notices: users switch tabs.
    await vscode.commands.executeCommand('workbench.action.previousEditor');
  }
  const window = { message: DEFAULT_MESSAGE, count: String(count), styled: true };
  report.windows = await untilShown(profile, name === 'other' ? [] : [window]);
  report.tabs = windowTabs().length;
  // At the next start, VS Code restores the window as a tab behind the note.
  if (name === 'restore') await hide();
}

/** Called by VS Code on `onStartupFinished`. */
export function activate(): void {
  const phase = JSON.parse(readFileSync(join(__dirname, 'phase.json'), 'utf8')) as Phase;
  const report: Report = {};
  void runPhase(phase, report)
    .catch((error: unknown) => {
      report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    })
    .finally(() => {
      const file = join(DIR, `${phase.name}.json`);
      // Renamed: a VS Code that ends in between never leaves half a file.
      writeFileSync(`${file}.part`, JSON.stringify(report));
      renameSync(`${file}.part`, file);
      // window.confirmBeforeClose is "never": nothing asks.
      void vscode.commands.executeCommand('workbench.action.quit');
    });
}
