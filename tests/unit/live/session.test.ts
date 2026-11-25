import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { bootId, identify, type ProcessInfo } from '../../../scripts/live/processes.ts';
import {
  abandonStart,
  assertOwnSession,
  createSession,
  describeAlreadyRunning,
  describeSessionProblem,
  ensureRunDir,
  readSession,
  removeSession,
  ownedElsewhere,
  ROOT,
  saveSession,
  sessionState,
  stopProcesses,
  type Session,
} from '../../../scripts/live/session.ts';

const linux = process.platform === 'linux';

let parent: string;
let dir: string;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'session-'));
  dir = join(parent, 'run');
});

afterEach(() => {
  rmSync(parent, { recursive: true });
});

function makeSession(changes: Partial<Session> = {}): Session {
  return {
    state: 'running',
    root: ROOT,
    boot: 'boot',
    starter: { name: 'start', pid: 1, started: '1' },
    startedAt: '2026-11-25T00:00:00.000Z',
    version: '1.146.0',
    novncUrl: 'http://127.0.0.1:6080/',
    processes: [],
    ...changes,
  };
}

describe('ensureRunDir', () => {
  it('makes a directory for this user only', () => {
    ensureRunDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('takes one that is there, with its files', () => {
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, 'a'), '');
    ensureRunDir(dir);
    expect(readdirSync(dir)).toEqual(['a']);
  });

  it.each([0o755, 0o770, 0o701])('refuses one that others may use (%o)', (mode) => {
    mkdirSync(dir);
    chmodSync(dir, mode);
    expect(() => {
      ensureRunDir(dir);
    }).toThrow(`${dir} is not a directory that only this user may use`);
  });

  it('refuses a link, also to a good directory', () => {
    const target = join(parent, 'target');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, dir);
    expect(() => {
      ensureRunDir(dir);
    }).toThrow('is not a directory');
  });

  it('refuses a file', () => {
    writeFileSync(dir, '', { mode: 0o600 });
    expect(() => {
      ensureRunDir(dir);
    }).toThrow('is not a directory');
  });

  it('does not make its parents', () => {
    expect(() => {
      ensureRunDir(join(dir, 'deep'));
    }).toThrow('ENOENT');
  });
});

describe('the session file', () => {
  it('is empty without a directory or file', () => {
    expect(readSession(dir)).toBeUndefined();
    ensureRunDir(dir);
    expect(readSession(dir)).toBeUndefined();
  });

  it('is read only from a directory of this user', () => {
    mkdirSync(dir);
    chmodSync(dir, 0o777);
    writeFileSync(join(dir, 'session.json'), JSON.stringify(makeSession()));
    expect(() => readSession(dir)).toThrow('only this user');
  });

  it('keeps a second start out', () => {
    ensureRunDir(dir);
    createSession(makeSession({ version: 'first' }), dir);
    expect(() => {
      createSession(makeSession({ version: 'second' }), dir);
    }).toThrow('a live session is already starting');
    expect(readSession(dir)?.version).toBe('first');
    expect(readdirSync(dir)).toEqual(['session.json']);
  });

  it('is replaced and removed', () => {
    ensureRunDir(dir);
    createSession(makeSession(), dir);
    saveSession(makeSession({ version: 'next' }), dir);
    expect(readSession(dir)?.version).toBe('next');
    expect(statSync(join(dir, 'session.json')).mode & 0o777).toBe(0o600);
    writeFileSync(join(dir, 'novnc-tokens'), '');
    removeSession(dir);
    expect(readdirSync(dir)).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });
});

describe('assertOwnSession', () => {
  it('takes a session of this checkout', () => {
    expect(() => {
      assertOwnSession(makeSession());
    }).not.toThrow();
  });

  it('names the other checkout', () => {
    expect(() => {
      assertOwnSession(makeSession({ root: parent }));
    }).toThrow(`the live session belongs to ${parent}`);
  });

  it('takes one whose checkout is gone', () => {
    expect(() => {
      assertOwnSession(makeSession({ root: join(parent, 'gone') }));
    }).not.toThrow();
  });
});

describe.runIf(linux)('sessionState', () => {
  async function deadProcess(): Promise<ProcessInfo> {
    const child = spawn('true');
    await once(child, 'exit');
    return { name: 'start', pid: child.pid ?? -1, started: '1' };
  }

  function liveProcess(): ProcessInfo {
    const child = spawn('sleep', ['30'], { detached: true });
    onTestFinished(() => {
      child.kill('SIGKILL');
    });
    return identify('vscode', child.pid ?? -1);
  }

  it('is gone after a restart, whatever the process IDs say', () => {
    const me = identify('start', process.pid);
    expect(sessionState(makeSession({ state: 'starting', starter: me }))).toBe('gone');
    expect(sessionState(makeSession({ processes: [liveProcess()] }))).toBe('gone');
  });

  it('is starting while the starter runs', () => {
    const starter = identify('start', process.pid);
    expect(sessionState(makeSession({ state: 'starting', boot: bootId(), starter }))).toBe(
      'starting',
    );
  });

  it('is gone if the starter died before it started anything', async () => {
    const starter = await deadProcess();
    expect(sessionState(makeSession({ state: 'starting', boot: bootId(), starter }))).toBe('gone');
  });

  it('is running if the starter died and something it started runs', async () => {
    const session = makeSession({
      state: 'starting',
      boot: bootId(),
      starter: await deadProcess(),
      processes: [liveProcess()],
    });
    expect(sessionState(session)).toBe('running');
  });

  it('is gone if nothing of it runs', async () => {
    const session = makeSession({ boot: bootId(), processes: [await deadProcess()] });
    expect(sessionState(session)).toBe('gone');
  });
});

describe('stopProcesses', () => {
  const processes: ProcessInfo[] = [
    { name: 'xvfb', pid: 1, started: '1' },
    { name: 'x11vnc', pid: 2, started: '1' },
    { name: 'vscode', pid: 3, started: '1' },
  ];

  it('ends VS Code first and gives it more time', async () => {
    const calls: [string, number][] = [];
    const graceful = await stopProcesses(processes, ({ name }, graceMs) => {
      calls.push([name, graceMs]);
      return Promise.resolve('stopped');
    });
    expect(graceful).toBe(true);
    expect(calls).toEqual([
      ['vscode', 30_000],
      ['x11vnc', 5000],
      ['xvfb', 5000],
    ]);
  });

  it('says if VS Code had to be killed, and only then', async () => {
    const killed = (victim: string) =>
      stopProcesses(processes, ({ name }) =>
        Promise.resolve(name === victim ? 'killed' : 'stopped'),
      );
    await expect(killed('vscode')).resolves.toBe(false);
    await expect(killed('x11vnc')).resolves.toBe(true);
  });

  it('ends the rest if one does not end, and names it', async () => {
    const calls: string[] = [];
    const stop = stopProcesses(processes, ({ name }) => {
      calls.push(name);
      return name === 'xvfb' ? Promise.resolve('stopped') : Promise.reject(new Error(`no ${name}`));
    });
    await expect(stop).rejects.toThrow('could not end vscode, x11vnc');
    await expect(stop).rejects.toHaveProperty('cause.message', 'no vscode');
    expect(calls).toEqual(['vscode', 'x11vnc', 'xvfb']);
  });
});

describe('ownedElsewhere', () => {
  it('is false for this checkout', () => {
    expect(ownedElsewhere(makeSession())).toBe(false);
  });

  it('is true for another checkout that is there', () => {
    expect(ownedElsewhere(makeSession({ root: parent }))).toBe(true);
  });

  it('is false for a checkout that is gone: nobody can stop it there', () => {
    expect(ownedElsewhere(makeSession({ root: join(parent, 'gone') }))).toBe(false);
  });
});

describe('abandonStart', () => {
  const processes: ProcessInfo[] = [
    { name: 'xvfb', pid: 1, started: '1' },
    { name: 'vscode', pid: 3, started: '1' },
  ];

  function started(): Session {
    ensureRunDir(dir);
    const session = makeSession({ state: 'starting', processes });
    createSession(session, dir);
    writeFileSync(join(dir, 'novnc-tokens'), '');
    return session;
  }

  it('ends what runs and removes the session file', async () => {
    const session = started();
    const failure = await abandonStart(session, () => Promise.resolve('stopped'), dir);
    expect(failure).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('keeps the session file if a process does not end, so that `stop` finds it', async () => {
    const session = started();
    const failure = await abandonStart(
      session,
      ({ name }) =>
        name === 'xvfb' ? Promise.reject(new Error('stuck')) : Promise.resolve('stopped'),
      dir,
    );
    expect(failure).toHaveProperty('message', 'could not end xvfb');
    expect(readSession(dir)?.processes).toEqual(processes);
  });
});

describe('describeSessionProblem', () => {
  const session = makeSession();

  it('has none for a running session with VS Code', () => {
    expect(describeSessionProblem(session, 'running', true)).toBeUndefined();
  });

  it('says there is none to use without a session or if nothing of it runs', () => {
    expect(describeSessionProblem(undefined, undefined, false)).toBe(
      'no live session runs; start one: npm run live -- start',
    );
    expect(describeSessionProblem(session, 'gone', false)).toBe(
      'no live session runs; start one: npm run live -- start',
    );
  });

  it('says to wait for a start that is at work', () => {
    expect(describeSessionProblem(session, 'starting', false)).toBe(
      'a live session is still starting (process 1); wait for its start to end',
    );
  });

  it('says to stop, then start, if VS Code ended but the rest of the session runs', () => {
    expect(describeSessionProblem(session, 'running', false)).toBe(
      'VS Code of the live session has ended, the rest of it still runs; stop, then start: npm run live -- stop, then npm run live -- start',
    );
  });
});

describe('describeAlreadyRunning', () => {
  it('says to stop it first', () => {
    expect(describeAlreadyRunning(true)).toBe(
      'a live session is already running; stop it first: npm run live -- stop',
    );
  });

  it('says to stop, then start, if VS Code of it ended', () => {
    expect(describeAlreadyRunning(false)).toBe(
      'a live session is already running, but its VS Code has ended; stop, then start: npm run live -- stop, then npm run live -- start',
    );
  });
});
