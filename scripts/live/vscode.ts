// VS Code of the session: its files, its command line, and the connection to its window.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Frame, type Page } from 'playwright-core';
import { installVsix, QUIET_FLAGS, QUIET_SETTINGS, run, vscodeFlags } from '../vscode-run.mjs';
import { ensureVscode, minimumVersion } from '../vscode.mjs';
import { DEBUG_PORT, INSPECT_PORT } from './novnc.ts';
import { leaderRuns, waitFor } from './processes.ts';
import {
  assertOwnSession,
  EXTENSIONS,
  HOME,
  PROFILE,
  readSession,
  ROOT,
  sessionState,
  TEMP,
  WORKSPACE,
  type Session,
} from './session.ts';

const CACHE = process.env.VSCODE_TEST_CACHE ?? join(ROOT, '.vscode-test');

const SETTINGS = {
  ...QUIET_SETTINGS,
  'chat.titleBar.signIn.enabled': false,
  'chat.welcomePage.signIn.enabled': false,
  'extensions.ignoreRecommendations': true,
  // Dialogs in the window: the agent cannot reach native ones.
  'files.simpleDialog.enable': true,
  'window.dialogStyle': 'custom',
  'window.newWindowDimensions': 'maximized',
  'workbench.enableExperiments': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'workbench.tips.enabled': false,
};

interface Manifest {
  name: string;
  publisher: string;
  version: string;
  engines: { vscode: string };
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Manifest;
}

export function extensionId(): string {
  const { publisher, name } = readManifest();
  return `${publisher}.${name}`;
}

/** The version in `engines.vscode`, which is the one the session runs. */
export function vscodeVersion(): string {
  return minimumVersion(readManifest().engines.vscode);
}

/** Returns the directory of VS Code. */
export function downloadVscode(): Promise<string> {
  return ensureVscode(vscodeVersion(), CACHE);
}

/** Returns the path of the .vsix. */
export function packageVsix(): string {
  run('npm', ['run', 'package'], { cwd: ROOT });
  const { name, version } = readManifest();
  return join(ROOT, `${name}-${version}.vsix`);
}

/**
 * Makes the profile, the workspace and HOME in the directory of the session. `keep` uses what the
 * last session left; the count is saved for the workspace folder, which VS Code recognizes by more
 * than its path.
 * @returns whether there was something to keep
 */
export function prepareFiles(keep: boolean): boolean {
  // Not the directory itself: the session file, which keeps other starts out, is in it.
  for (const dir of keep ? [TEMP] : [PROFILE, EXTENSIONS, WORKSPACE, HOME, TEMP]) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  const kept = existsSync(PROFILE);
  for (const dir of [join(PROFILE, 'User'), EXTENSIONS, WORKSPACE, HOME, TEMP]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const [file, text] of [
    [join(PROFILE, 'User', 'settings.json'), JSON.stringify(SETTINGS, undefined, 2)],
    [join(WORKSPACE, 'note.txt'), 'A file to open next to the Demo window.\n'],
  ] as const) {
    if (!existsSync(file)) writeFileSync(file, text);
  }
  return kept;
}

/** The directory of the installed extension. */
export function installedDir(): string {
  const id = extensionId();
  const file = join(EXTENSIONS, 'extensions.json');
  const entries = JSON.parse(readFileSync(file, 'utf8')) as {
    identifier: { id: string };
    relativeLocation: string;
  }[];
  const entry = entries.find(({ identifier }) => identifier.id === id);
  if (!entry) throw new Error(`${id} is not in ${file}`);
  return join(EXTENSIONS, entry.relativeLocation);
}

/** Installs the .vsix, also over the same version, and checks that its files are in place. */
export function install(vscode: string, vsix: string, env: NodeJS.ProcessEnv): void {
  installVsix(vscode, vscodeFlags(PROFILE, EXTENSIONS), vsix, env, { force: true });
  const dir = installedDir();
  for (const file of ['dist/extension.js', 'dist/webview.js']) {
    if (!readFileSync(join(dir, file)).equals(readFileSync(join(ROOT, file)))) {
      throw new Error(`${join(dir, file)} is not the one that was built`);
    }
  }
}

/** Both debug ports listen on 127.0.0.1 only: Chromium and the extension host of VS Code do so. */
export function vscodeArgs(): string[] {
  return [
    ...vscodeFlags(PROFILE, EXTENSIONS),
    ...QUIET_FLAGS,
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--inspect-extensions=${INSPECT_PORT}`,
    WORKSPACE,
  ];
}

export interface Connection {
  /** The window of VS Code. */
  page: Page;
  /**
   * The document of the Demo window, or undefined if there is none: not open, or its tab is hidden.
   * VS Code makes a new one each time the tab is shown, so ask again for every use.
   */
  webview(): Promise<Frame | undefined>;
  /** Disconnects; VS Code stays. */
  close(): Promise<void>;
}

/** Connects to the window of the running session. */
export async function connect(): Promise<Connection> {
  ownRunningSession();
  return attach(15_000);
}

/** The session of this checkout, with VS Code running; throws if there is none. */
export function ownRunningSession(): Session {
  const session = readSession();
  const vscode = session?.processes.find(({ name }) => name === 'vscode');
  if (!session || !vscode || sessionState(session) !== 'running' || !leaderRuns(vscode)) {
    throw new Error('no live session runs; start one: npm run live -- start');
  }
  assertOwnSession(session);
  return session;
}

/** Connects and waits until the window is ready: its status bar is visible. */
export async function attach(timeoutMs: number, signal?: AbortSignal): Promise<Connection> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`, {
    timeout: timeoutMs,
  });
  try {
    const page = await waitFor('the window of VS Code opens', () => workbenchPage(browser), {
      timeoutMs,
      signal,
    });
    await page
      .locator('[id="workbench.parts.statusbar"]')
      .waitFor({ state: 'visible', timeout: timeoutMs });
    return { page, webview: () => demoFrame(page), close: () => browser.close() };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

function workbenchPage(browser: Browser): Page | undefined {
  return browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((page) => /\/workbench\.html\b/.test(page.url()));
}

/**
 * VS Code shows a webview in an iframe whose URL names the extension, and the HTML of the extension
 * in an iframe in that one. While it loads there can be a second inner one.
 */
async function demoFrame(page: Page): Promise<Frame | undefined> {
  const id = extensionId();
  const outer = () =>
    page.frames().filter((frame) => URL.parse(frame.url())?.searchParams.get('extensionId') === id);
  if (outer().length === 0) return undefined;
  return waitFor(
    'the Demo window shows the count',
    async () => {
      for (const frame of outer().flatMap((frame) => frame.childFrames())) {
        if (await showsCount(frame)) return frame;
      }
      return undefined;
    },
    { timeoutMs: 10_000 },
  );
}

async function showsCount(frame: Frame): Promise<boolean> {
  try {
    return await frame.evaluate('(document.getElementById("count")?.textContent ?? "") !== ""');
  } catch {
    return false; // The frame was replaced in between.
  }
}
