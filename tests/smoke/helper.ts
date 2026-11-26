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
  name: 'count' | 'restore' | 'other';
  profile: string;
  count: number;
}

/** What VS Code showed. */
export interface Report {
  /** The count of the extension. */
  count?: number;
  /** At the end: the pages of the window, or why they could not be read. */
  windows?: Page[] | string;
  /** At the end: the tabs of the window. */
  tabs?: number;
  error?: string;
}

const DIR = dirname(__dirname);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Reads until `done` says so or the time is up; returns the last value it read. */
async function until<T>(
  read: () => T | Promise<T>,
  done: (value: T) => boolean,
  seconds = 20,
): Promise<T> {
  const end = Date.now() + seconds * 1000;
  let value = await read();
  while (!done(value) && Date.now() < end) {
    await sleep(50);
    value = await read();
  }
  return value;
}

const demo = () => vscode.extensions.getExtension<DemoApi>(EXTENSION_ID);

const windowTabs = () =>
  vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) =>
        tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(VIEW_TYPE),
    );

async function windows(profile: string): Promise<Page[] | string> {
  try {
    return (await readScreen(profile)).windows;
  } catch (error) {
    // A page that comes or goes cannot be read.
    return error instanceof Error ? error.message : String(error);
  }
}

async function runPhase({ name, profile, count }: Phase, report: Report): Promise<void> {
  // Never activates it: `onStartupFinished` or the restored window must.
  if (!(await until(() => demo()?.isActive === true, Boolean, 60))) {
    throw new Error(`${EXTENSION_ID} is not active after 60 s`);
  }
  report.count = demo()?.exports.getCount();
  if (name === 'count') {
    await vscode.commands.executeCommand(COMMANDS.openWindow);
    for (let i = 0; i < count; i++) await vscode.commands.executeCommand(COMMANDS.increment);
    report.count = demo()?.exports.getCount();
  }
  const expected =
    name === 'other' ? [] : [{ message: DEFAULT_MESSAGE, count: String(count), styled: true }];
  report.windows = await until(
    () => windows(profile),
    (shown) => isDeepStrictEqual(shown, expected),
  );
  report.tabs = windowTabs().length;
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
