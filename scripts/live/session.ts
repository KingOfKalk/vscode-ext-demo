// The session file: what runs, for the commands after `start`. It is in RUN_DIR, like everything of
// the session: ports and processes belong to the machine or container, not to a checkout.
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { bootId, groupRuns, leaderRuns, stopGroup, type ProcessInfo } from './processes.ts';

export const ROOT = resolve(import.meta.dirname, '../..');
/** Screenshots. Gitignored. */
export const LIVE_DIR = join(ROOT, '.vscode-live');

/** Not os.tmpdir(): VS Code does not start with a profile under a long path. */
export const RUN_DIR = '/tmp/vscode-ext-demo-live';
export const PROFILE = join(RUN_DIR, 'profile');
export const EXTENSIONS = join(RUN_DIR, 'extensions');
export const WORKSPACE = join(RUN_DIR, 'workspace');
export const HOME = join(RUN_DIR, 'home');
export const TEMP = join(RUN_DIR, 'tmp');
/** The output of the processes. */
export const LOG_DIR = join(RUN_DIR, 'logs');
export const VNC_SOCKET = join(RUN_DIR, 'vnc.sock');
const SESSION_NAME = 'session.json';
const TOKENS_NAME = 'novnc-tokens';
/** For websockify, see start.ts. */
export const NOVNC_TOKENS = join(RUN_DIR, TOKENS_NAME);

/** VS Code saves its state when it ends; this is longer than that ever took. */
const VSCODE_GRACE_MS = 30_000;
const OTHER_GRACE_MS = 5000;

export interface Session {
  state: 'starting' | 'running';
  /** The checkout it was started from. */
  root: string;
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

/**
 * Makes the directory of the session. Its path is known to everyone on this machine, and what is in
 * it decides which programs run and which processes end, so nobody else may have made or use it.
 */
export function ensureRunDir(dir = RUN_DIR): void {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  assertRunDir(dir);
}

function assertRunDir(dir: string): void {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error(`${dir} is not a directory that only this user may use`);
  }
}

export function readSession(dir = RUN_DIR): Session | undefined {
  if (lstatSync(dir, { throwIfNoEntry: false }) === undefined) return undefined;
  assertRunDir(dir);
  let text;
  try {
    text = readFileSync(join(dir, SESSION_NAME), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(text) as Session;
}

/** Writes the file next to its place, so that it gets there in one step. */
function write(session: Session, dir: string): string {
  const part = join(dir, `${SESSION_NAME}.${process.pid}`);
  writeFileSync(part, JSON.stringify(session, undefined, 2), { mode: 0o600 });
  return part;
}

/** Throws if there is a session file, also if another `start` made it a moment ago. */
export function createSession(session: Session, dir = RUN_DIR): void {
  const part = write(session, dir);
  try {
    linkSync(part, join(dir, SESSION_NAME));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error('a live session is already starting', { cause: error });
  } finally {
    rmSync(part);
  }
}

export function saveSession(session: Session, dir = RUN_DIR): void {
  renameSync(write(session, dir), join(dir, SESSION_NAME));
}

export function removeSession(dir = RUN_DIR): void {
  rmSync(join(dir, SESSION_NAME), { force: true });
  rmSync(join(dir, TOKENS_NAME), { force: true });
}

/** Throws, naming the other checkout, if the session is not of this one. */
export function assertOwnSession({ root }: Session): void {
  // Nobody can stop it from a checkout that was removed.
  if (root !== ROOT && existsSync(root)) {
    throw new Error(`the live session belongs to ${root}; use it there`);
  }
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

/**
 * Ends what runs, VS Code first; throws at the end if something does not end.
 * @param stopOne injected by the tests
 * @returns whether VS Code ended by itself after SIGTERM
 */
export async function stopProcesses(
  processes: readonly ProcessInfo[],
  stopOne: typeof stopGroup = stopGroup,
): Promise<boolean> {
  let graceful = true;
  const left: string[] = [];
  let cause: unknown;
  for (const info of processes.toReversed()) {
    const isVscode = info.name === 'vscode';
    try {
      const ending = await stopOne(info, isVscode ? VSCODE_GRACE_MS : OTHER_GRACE_MS);
      if (isVscode && ending === 'killed') graceful = false;
    } catch (error) {
      left.push(info.name);
      cause ??= error;
    }
  }
  if (left.length > 0) throw new Error(`could not end ${left.join(', ')}`, { cause });
  return graceful;
}

export async function stop(): Promise<void> {
  const session = readSession();
  if (!session) {
    console.log('No live session runs.');
    return;
  }
  const state = sessionState(session);
  if (state !== 'gone') assertOwnSession(session);
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
    console.log(
      `The live session of ${session.root} is starting (process ${session.starter.pid}).`,
    );
    return;
  }
  const parts = session.processes.map((info) => ({
    ...info,
    runs: state === 'running' && leaderRuns(info),
  }));
  console.log(
    `Live session of ${session.root}, since ${session.startedAt}, VS Code ${session.version}`,
  );
  for (const { name, pid, runs } of parts) {
    console.log(`${name.padEnd(8)} ${runs ? `runs (process ${pid})` : 'does not run'}`);
  }
  console.log(`noVNC    ${session.novncUrl}`);
  if (session.state !== 'running' || parts.some(({ runs }) => !runs)) {
    throw new Error('the live session is not complete; run in its checkout: npm run live -- stop');
  }
}
