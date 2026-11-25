// Starts the session: Xvfb, a window manager, VNC, noVNC and VS Code. All or nothing.
import { randomBytes } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { connect as connectTcp } from 'node:net';
import { delimiter, join } from 'node:path';
import { spawnGroup, startXvfb } from '../vscode-run.mjs';
import {
  DEBUG_PORT,
  INSPECT_PORT,
  isLoopback,
  novncAddress,
  novncUrl,
  readNovncConfig,
  VNC_PORT,
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
  createSession,
  LOG_DIR,
  NOVNC_TOKENS,
  readSession,
  removeSession,
  saveSession,
  sessionState,
  stopProcesses,
  type Session,
} from './session.ts';
import {
  attach,
  downloadVscode,
  install,
  packageVsix,
  prepareFiles,
  sessionEnv,
  vscodeArgs,
  vscodeVersion,
} from './vscode.ts';

const NOVNC_FILES = '/usr/share/novnc';
const SCREEN = '1440x900x24';

export async function start(keep: boolean): Promise<void> {
  const novnc = readNovncConfig(process.env);
  assertNotRunning();
  assertInstalled();
  for (const [use, host, port] of [
    ['noVNC', novnc.host, novnc.port],
    ['VNC', '127.0.0.1', VNC_PORT],
    ['window debugger', '127.0.0.1', DEBUG_PORT],
    ['extension host debugger', '127.0.0.1', INSPECT_PORT],
  ] as const) {
    await assertPortFree(use, host, port);
  }

  // The session file comes first: it keeps a second start out, and names everything that runs.
  const token = randomBytes(16).toString('hex');
  const session: Session = {
    state: 'starting',
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
    await stopProcesses(session.processes);
    removeSession();
    throw error;
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
  switch (sessionState(session)) {
    case 'starting':
      throw new Error(`a live session is already starting (process ${session.starter.pid})`);
    case 'running':
      throw new Error('a live session is already running; stop it first: npm run live -- stop');
    case 'gone':
      removeSession();
  }
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

    const display = await this.#startXvfb(env);
    const desktop = { ...env, DISPLAY: display };
    const openbox = this.#launch('openbox', 'openbox', ['--sm-disable'], desktop);
    const vnc = this.#launch('x11vnc', 'x11vnc', vncArgs(display), desktop);
    await this.#ready(vnc, 'answers', 15_000, () => accepts(VNC_PORT));

    writeFileSync(NOVNC_TOKENS, `${token}: 127.0.0.1:${VNC_PORT}\n`, { mode: 0o600 });
    const web = this.#launch('novnc', 'websockify', novncArgs(novnc), env);
    const page = new URL(this.#session.novncUrl);
    page.hash = '';
    await this.#ready(web, 'serves its page', 15_000, () => answers(page.href));

    const code = this.#launch('vscode', join(vscode, 'code'), vscodeArgs(), desktop);
    await this.#ready(code, 'opens its debug port', 60_000, () =>
      answers(`http://127.0.0.1:${DEBUG_PORT}/json/version`),
    );
    const connection = await attach(60_000, this.#signal);
    await connection.close();
    await this.#ready(code, 'starts its extension host', 60_000, () =>
      answers(`http://127.0.0.1:${INSPECT_PORT}/json/version`),
    );
    for (const info of [openbox, vnc, web, code]) assertRuns(info);
    return kept;
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
  const lines = readFileSync(logFile(info.name), 'utf8').trimEnd().split('\n').slice(-10);
  throw new Error(`${info.name} ended. The end of its log:\n${lines.join('\n')}`);
}

/**
 * No VNC password: x11vnc listens on 127.0.0.1 only, and who can connect there is on this machine
 * and can as well use the debug ports.
 */
function vncArgs(display: string): string[] {
  return [
    ...['-display', display, '-rfbport', String(VNC_PORT)],
    // Without all three it also listens on IPv6; -rfbportv6 alone or -noipv6 alone is not enough.
    ...['-localhost', '-noipv6', '-rfbportv6', '-1'],
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

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connectTcp({ host: '127.0.0.1', port, timeout: 2000 });
    const end = (result: boolean) => () => {
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', end(true));
    socket.once('error', end(false));
    socket.once('timeout', end(false));
  });
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
