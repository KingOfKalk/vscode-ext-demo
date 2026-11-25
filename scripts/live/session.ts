// The session file: what runs, for the commands after `start`. Nothing of a session is written
// outside .vscode-live/ (gitignored) and RUN_DIR.
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { bootId, groupRuns, leaderRuns, stopGroup, type ProcessInfo } from './processes.ts';

export const ROOT = resolve(import.meta.dirname, '../..');
export const LIVE_DIR = join(ROOT, '.vscode-live');
export const LOG_DIR = join(LIVE_DIR, 'logs');
const SESSION_FILE = join(LIVE_DIR, 'session.json');
/** For websockify, see start.ts. */
export const NOVNC_TOKENS = join(LIVE_DIR, 'novnc-tokens');

/** Not os.tmpdir(): VS Code does not start with a profile under a long path. */
export const RUN_DIR = '/tmp/vscode-ext-demo-live';
export const PROFILE = join(RUN_DIR, 'profile');
export const EXTENSIONS = join(RUN_DIR, 'extensions');
export const WORKSPACE = join(RUN_DIR, 'workspace');
export const HOME = join(RUN_DIR, 'home');
export const TEMP = join(RUN_DIR, 'tmp');

/** VS Code saves its state when it ends; this is longer than that ever took. */
const VSCODE_GRACE_MS = 30_000;
const OTHER_GRACE_MS = 5000;

export interface Session {
  state: 'starting' | 'running';
  /** See `bootId`. */
  boot: string;
  /** The script that starts the session. */
  starter: ProcessInfo;
  startedAt: string;
  /** Of VS Code. */
  version: string;
  novncUrl: string;
  /** In the order they were started. */
  processes: ProcessInfo[];
}

export function readSession(): Session | undefined {
  let text;
  try {
    text = readFileSync(SESSION_FILE, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(text) as Session;
}

/** Writes the file in one step; only this user may read the URL in it. */
function write(session: Session): string {
  mkdirSync(LIVE_DIR, { recursive: true, mode: 0o700 });
  const part = `${SESSION_FILE}.${process.pid}`;
  writeFileSync(part, JSON.stringify(session, undefined, 2), { mode: 0o600 });
  return part;
}

/** Throws if there is a session file, also if another `start` made it a moment ago. */
export function createSession(session: Session): void {
  const part = write(session);
  try {
    linkSync(part, SESSION_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error('a live session is already starting', { cause: error });
  } finally {
    rmSync(part);
  }
}

export function saveSession(session: Session): void {
  renameSync(write(session), SESSION_FILE);
}

export function removeSession(): void {
  rmSync(SESSION_FILE, { force: true });
  rmSync(NOVNC_TOKENS, { force: true });
}

/**
 * - `starting`: a `start` is at work.
 * - `running`: something runs, see `leaderRuns` for what.
 * - `gone`: nothing does. An unclean end, or a file from before a restart of the system or container.
 */
export function sessionState(session: Session): 'starting' | 'running' | 'gone' {
  if (session.boot !== bootId()) return 'gone';
  if (session.state === 'starting' && leaderRuns(session.starter)) return 'starting';
  return session.processes.some(groupRuns) ? 'running' : 'gone';
}

/** Ends what runs, VS Code first. Returns whether VS Code ended by itself after SIGTERM. */
export async function stopProcesses(processes: readonly ProcessInfo[]): Promise<boolean> {
  let graceful = true;
  for (const info of processes.toReversed()) {
    const isVscode = info.name === 'vscode';
    const ending = await stopGroup(info, isVscode ? VSCODE_GRACE_MS : OTHER_GRACE_MS);
    if (isVscode && ending === 'killed') graceful = false;
  }
  return graceful;
}

export async function stop(): Promise<void> {
  const session = readSession();
  if (!session) {
    console.log('No live session runs.');
    return;
  }
  const state = sessionState(session);
  if (state === 'starting') {
    throw new Error(
      `the live session is starting (process ${session.starter.pid}); end that first`,
    );
  }
  const graceful = state === 'gone' || (await stopProcesses(session.processes));
  removeSession();
  if (!graceful) {
    throw new Error(
      `stopped, but VS Code had to be killed after ${VSCODE_GRACE_MS / 1000} s; it may not have saved its state`,
    );
  }
  console.log(
    state === 'gone' ? 'The live session was gone already.' : 'The live session stopped.',
  );
}

/** Prints what runs. Fails if a session should run and a part of it does not. */
export function status(): void {
  const session = readSession();
  if (!session) {
    console.log('No live session runs.');
    return;
  }
  const state = sessionState(session);
  if (state === 'starting') {
    console.log(`The live session is starting (process ${session.starter.pid}).`);
    return;
  }
  const parts = session.processes.map((info) => ({
    ...info,
    runs: state === 'running' && leaderRuns(info),
  }));
  console.log(`Live session of ${session.startedAt}, VS Code ${session.version}`);
  for (const { name, pid, runs } of parts) {
    console.log(`${name.padEnd(8)} ${runs ? `runs (process ${pid})` : 'does not run'}`);
  }
  console.log(`noVNC    ${session.novncUrl}`);
  if (session.state !== 'running' || parts.some(({ runs }) => !runs)) {
    throw new Error('the live session is not complete; run: npm run live -- stop');
  }
}
