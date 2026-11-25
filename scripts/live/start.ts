// Starts the session: Xvfb, a window manager, VNC, noVNC and VS Code. All or nothing.
import { randomBytes } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { spawnGroup, startXvfb } from '../vscode-run.mjs';
import { describeFailure } from '../vscode.mjs';
import { sessionEnv } from './environment.ts';
import { explainNoActivation, readActivationState, type ActivationSource } from './activation.ts';
import { decideActivation, isActivated, listRuns, runLogs, tail } from './logs.ts';
import {
  DEBUG_PORT,
  INSPECT_PORT,
  isLoopback,
  novncAddress,
  novncUrl,
  readNovncConfig,
  type NovncConfig,
} from './novnc.ts';
import {
  assertPortFree,
  bootId,
  identify,
  leaderRuns,
  waitFor,
  type ProcessInfo,
  type ProcessName,
} from './processes.ts';
import {
  abandonStart,
  createSession,
  describeAlreadyRunning,
  ensureRunDir,
  LOG_DIR,
  NOVNC_TOKENS,
  ownedElsewhere,
  readSession,
  removeSession,
  ROOT,
  saveSession,
  sessionState,
  VNC_SOCKET,
  VSCODE_LOGS,
  vscodeOfSessionRuns,
  type Session,
} from './session.ts';
import {
  attach,
  downloadVscode,
  extensionId,
  install,
  packageVsix,
  prepareFiles,
  vscodeArgs,
  vscodeVersion,
} from './vscode.ts';

const NOVNC_FILES = '/usr/share/novnc';
const SCREEN = '1440x900x24';

export async function start(keep: boolean): Promise<void> {
  const novnc = readNovncConfig(process.env);
  ensureRunDir();
  assertNotRunning();
  assertInstalled();
  await assertPortsFree(novnc);

  // The session file comes first: it keeps a second start out, and names everything that runs.
  const token = randomBytes(16).toString('hex');
  const session: Session = {
    state: 'starting',
    root: ROOT,
    boot: bootId(),
    starter: identify('start', process.pid),
    startedAt: new Date().toISOString(),
    version: vscodeVersion(),
    novncUrl: novncUrl(novnc, token),
    processes: [],
  };
  createSession(session);

  const abort = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      abort.abort(new Error(`interrupted by ${signal}`));
    });
  }
  let kept;
  try {
    kept = await new Starter(session, abort.signal).run(keep, novnc, token);
    session.state = 'running';
    saveSession(session);
  } catch (error) {
    const left = await abandonStart(session);
    if (left === undefined) throw error;
    throw new Error(
      `the start failed, and the cleanup ${describeFailure(left)}; what survived stays in the session file: npm run live -- stop`,
      { cause: error },
    );
  }

  console.log(
    `The live session runs: VS Code ${session.version}, ${kept ? 'kept' : 'new'} profile`,
  );
  if (!isLoopback(novnc.host)) {
    console.log(
      `Warning: noVNC listens on ${novncAddress(novnc)}. Whoever reaches it and has the URL controls VS Code.`,
    );
  }
  console.log(`noVNC: ${session.novncUrl}`);
}

function assertNotRunning(): void {
  const session = readSession();
  if (!session) return;
  const state = sessionState(session);
  // Not if its checkout is gone: nobody could stop it there, and `stop` works from here.
  if (state !== 'gone' && ownedElsewhere(session)) {
    throw new Error(`a live session of ${session.root} is already ${state}; stop it there first`);
  }
  switch (state) {
    case 'starting':
      throw new Error(`a live session is already starting (process ${session.starter.pid})`);
    case 'running':
      throw new Error(describeAlreadyRunning(vscodeOfSessionRuns(session)));
    case 'gone':
      removeSession();
  }
}

async function assertPortsFree(novnc: NovncConfig): Promise<void> {
  await assertPortFree('noVNC', novnc.host, novnc.port);
  await assertPortFree('window debugger', '127.0.0.1', DEBUG_PORT);
  await assertPortFree('extension host debugger', '127.0.0.1', INSPECT_PORT);
}

/** Throws if a program that the session needs is not installed. */
function assertInstalled(): void {
  const dirs = (process.env.PATH ?? '').split(delimiter);
  const exists = (file: string, mode: number): boolean => {
    try {
      accessSync(file, mode);
      return true;
    } catch {
      return false;
    }
  };
  const missing = ['Xvfb', 'openbox', 'x11vnc', 'websockify'].filter(
    (name) => !dirs.some((dir) => exists(join(dir, name), constants.X_OK)),
  );
  if (!exists(join(NOVNC_FILES, 'vnc.html'), constants.R_OK)) missing.push('noVNC');
  if (missing.length > 0) {
    throw new Error(`missing: ${missing.join(', ')}; run scripts/install-system-deps.sh --live`);
  }
}

class Starter {
  readonly #session: Session;
  readonly #signal: AbortSignal;

  constructor(session: Session, signal: AbortSignal) {
    this.#session = session;
    this.#signal = signal;
  }

  /** Returns whether the profile of the last session was kept. */
  async run(keep: boolean, novnc: NovncConfig, token: string): Promise<boolean> {
    const vsix = packageVsix();
    const vscode = await downloadVscode();
    this.#signal.throwIfAborted();
    const kept = prepareFiles(keep);
    mkdirSync(LOG_DIR, { recursive: true });
    const env = sessionEnv();
    install(vscode, vsix, env);
    this.#signal.throwIfAborted();
    // Again: VS Code would silently take other ports, and the build took a while.
    await assertPortsFree(novnc);

    const display = await this.#startXvfb(env);
    const desktop = { ...env, DISPLAY: display };
    const openbox = this.#launch('openbox', 'openbox', ['--sm-disable'], desktop);
    rmSync(VNC_SOCKET, { force: true });
    const vnc = this.#launch('x11vnc', 'x11vnc', vncArgs(display), desktop);
    await this.#ready(vnc, 'opens its socket', 15_000, () => Promise.resolve(isSocket(VNC_SOCKET)));

    writeFileSync(NOVNC_TOKENS, `${token}: unix_socket:${VNC_SOCKET}\n`, { mode: 0o600 });
    const web = this.#launch('novnc', 'websockify', novncArgs(novnc), env);
    const page = new URL(this.#session.novncUrl);
    page.hash = '';
    await this.#ready(web, 'serves its page', 15_000, () => answers(page.href));

    const before = listRuns(VSCODE_LOGS);
    const code = this.#launch('vscode', join(vscode, 'code'), vscodeArgs(), desktop);
    await this.#ready(code, 'opens its debug port', 60_000, () =>
      answers(`http://127.0.0.1:${DEBUG_PORT}/json/version`),
    );
    const connection = await attach(60_000, this.#signal);
    await connection.close();
    await this.#ready(code, 'starts its extension host', 60_000, () =>
      answers(`http://127.0.0.1:${INSPECT_PORT}/json/version`),
    );
    await this.#activated(code, before);
    for (const info of [openbox, vnc, web, code]) assertRuns(info);
    return kept;
  }

  /**
   * Waits for the first event: the extension activates, `activate()` fails, or VS Code or its
   * extension host ends. The time limit is only for a hang. The status bar does not tell: a kept
   * profile may hide the count.
   */
  async #activated(code: ProcessInfo, before: readonly string[]): Promise<void> {
    const id = extensionId();
    const source: ActivationSource = {
      logs: VSCODE_LOGS,
      before,
      id,
      vscodeRuns: () => leaderRuns(code),
      isActivated: () => isActivated(VSCODE_LOGS, before, id),
    };
    const outcome = await waitFor(
      () => {
        const logs = runLogs(VSCODE_LOGS, before, id);
        if (!logs) return `the window writes logs to ${VSCODE_LOGS}`;
        return `the extension activates; see ${logs.demo}\nThe end of ${logs.host}:\n${tail(logs.host)}`;
      },
      () => {
        const { state } = readActivationState(source);
        const decision = decideActivation(state);
        return decision === undefined ? undefined : { decision, state };
      },
      { timeoutMs: 30_000, signal: this.#signal },
    );
    if (outcome.decision === 'activated') return;
    if (outcome.state.failed) {
      throw new Error(explainNoActivation({ kind: 'failed' }, source, VSCODE_LOGS));
    }
    // VS Code itself: its own log says why.
    if (outcome.state.vscodeEnded) assertRuns(code);
    throw new Error(explainNoActivation({ kind: 'host' }, source, VSCODE_LOGS));
  }

  async #startXvfb(env: NodeJS.ProcessEnv): Promise<string> {
    this.#signal.throwIfAborted();
    try {
      return await withLog('xvfb', (output) =>
        startXvfb({
          env,
          output,
          screen: SCREEN,
          onSpawn: (child) => {
            if (child.pid !== undefined) this.#register('xvfb', child);
          },
        }),
      );
    } catch (error) {
      throw new Error(`there is no display; see ${logFile('xvfb')}`, { cause: error });
    }
  }

  #launch(name: ProcessName, command: string, args: string[], env: NodeJS.ProcessEnv): ProcessInfo {
    this.#signal.throwIfAborted();
    return withLog(name, (output) =>
      this.#register(name, spawnGroup(command, args, env, { output })),
    );
  }

  /** From here on, a failed start and `stop` end the process. */
  #register(name: ProcessName, child: ChildProcess): ProcessInfo {
    child.unref();
    if (child.pid === undefined) {
      child.once('error', () => undefined);
      throw new Error(`cannot start ${name}`);
    }
    const info = identify(name, child.pid);
    this.#session.processes.push(info);
    saveSession(this.#session);
    return info;
  }

  #ready(
    info: ProcessInfo,
    what: string,
    timeoutMs: number,
    attempt: () => Promise<boolean>,
  ): Promise<true> {
    return waitFor(
      `${info.name} ${what}; see ${logFile(info.name)}`,
      async () => {
        assertRuns(info);
        return (await attempt()) || undefined;
      },
      { timeoutMs, signal: this.#signal },
    );
  }
}

function logFile(name: ProcessName): string {
  return join(LOG_DIR, `${name}.log`);
}

function withLog<T>(name: ProcessName, use: (output: number) => T): T {
  const output = openSync(logFile(name), 'w', 0o600);
  try {
    return use(output);
  } finally {
    closeSync(output);
  }
}

function assertRuns(info: ProcessInfo): void {
  if (leaderRuns(info)) return;
  throw new Error(`${info.name} ended. The end of its log:\n${tail(logFile(info.name))}`);
}

/**
 * A unix socket in a directory of this user, so no VNC password. Never a port, also not one on
 * 127.0.0.1: x11vnc takes WebSockets there, from web pages of any origin, around the token of noVNC.
 */
function vncArgs(display: string): string[] {
  return [
    ...['-display', display, '-unixsock', VNC_SOCKET, '-rfbport', '0'],
    // Without these two it still listens on [::]:5900.
    ...['-noipv6', '-rfbportv6', '-1'],
    ...['-nopw', '-norc'],
    ...['-forever', '-shared', '-quiet'],
  ];
}

/**
 * Binding to 127.0.0.1 leaves it to the browser of the owner to keep foreign web pages out:
 * websockify takes a WebSocket from any origin. So the URL has a token.
 */
function novncArgs(novnc: NovncConfig): string[] {
  return [
    `--web=${NOVNC_FILES}`,
    '--file-only',
    '--token-plugin=TokenFile',
    `--token-source=${NOVNC_TOKENS}`,
    novncAddress(novnc),
  ];
}

function isSocket(file: string): boolean {
  return lstatSync(file, { throwIfNoEntry: false })?.isSocket() ?? false;
}

async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}
