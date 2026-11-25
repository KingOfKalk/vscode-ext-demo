import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { describe, expect, it, onTestFinished } from 'vitest';
import { killGroup, spawnGroup } from '../../../scripts/vscode-run.mjs';
import {
  assertPortFree,
  groupRuns,
  identify,
  leaderRuns,
  parseStat,
  stopGroup,
  waitFor,
} from '../../../scripts/live/processes.ts';

const linux = process.platform === 'linux';

/** The tail of a real /proc/<pid>/stat, from the state on. */
const stat = (name: string, state: string) =>
  `4242 (${name}) ${state} 1 4240 4240 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 5000 100\n`;

describe('parseStat', () => {
  it('reads state, group and start time', () => {
    expect(parseStat(stat('code', 'S'))).toEqual({ state: 'S', group: 4240, started: '987654' });
  });

  it('copes with spaces and parentheses in the name', () => {
    expect(parseStat(stat('a) R (b', 'Z'))).toEqual({
      state: 'Z',
      group: 4240,
      started: '987654',
    });
  });
});

describe.runIf(linux)('processes', () => {
  async function start(script: string) {
    const child = spawnGroup('sh', ['-c', script], process.env);
    onTestFinished(() => {
      killGroup(child.pid);
    });
    await once(child, 'spawn');
    const info = identify('vscode', child.pid ?? -1);
    // The scripts that must not get ahead of the test say when they are ready.
    if (script.includes('echo ready') && child.stdout) await once(child.stdout, 'data');
    return info;
  }

  it('finds a process that runs, and not one that ended', async () => {
    const info = await start('exec sleep 30');
    expect(leaderRuns(info)).toBe(true);
    expect(groupRuns(info)).toBe(true);
    await stopGroup(info, 5000);
    expect(leaderRuns(info)).toBe(false);
    expect(groupRuns(info)).toBe(false);
  });

  it('does not take another process with the same ID for it', async () => {
    const info = { ...(await start('exec sleep 30')), started: '1' };
    expect(leaderRuns(info)).toBe(false);
    expect(groupRuns(info)).toBe(false);
    await expect(stopGroup(info, 100)).resolves.toBe('stopped');
  });

  it('sees the rest of a group whose first process is gone', async () => {
    const info = await start('sleep 30 & sleep 0.3');
    await waitFor('the first process ends', () => !leaderRuns(info) || undefined, {
      timeoutMs: 5000,
    });
    expect(groupRuns(info)).toBe(true);
    await expect(stopGroup(info, 5000)).resolves.toBe('stopped');
    expect(groupRuns(info)).toBe(false);
  });

  it('kills what does not stop, and says so', async () => {
    const info = await start('trap "" TERM; echo ready; while :; do sleep 0.1; done');
    await expect(stopGroup(info, 500)).resolves.toBe('killed');
    expect(groupRuns(info)).toBe(false);
  });

  it('does not identify a process that is gone', async () => {
    const child = spawn('true');
    await once(child, 'exit');
    expect(() => identify('vscode', child.pid ?? -1)).toThrow('vscode ended');
  });
});

describe('waitFor', () => {
  it('returns the first value that is not undefined', async () => {
    let calls = 0;
    await expect(
      waitFor('three calls', () => (++calls === 3 ? calls : undefined), {
        timeoutMs: 5000,
        pauseMs: 1,
      }),
    ).resolves.toBe(3);
  });

  it('names what did not happen', async () => {
    await expect(
      waitFor('a miracle', () => undefined, { timeoutMs: 20, pauseMs: 1 }),
    ).rejects.toThrow('waited 0.02 s, but this did not happen: a miracle');
  });

  it('ends with the signal', async () => {
    const abort = new AbortController();
    setTimeout(() => {
      abort.abort(new Error('interrupted'));
    }, 20);
    await expect(
      waitFor('a miracle', () => undefined, { timeoutMs: 5000, signal: abort.signal }),
    ).rejects.toThrow('interrupted');
  });
});

describe('assertPortFree', () => {
  it('names the port that is taken', async () => {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    await expect(assertPortFree('noVNC', '127.0.0.1', port)).rejects.toThrow(
      `port ${port} (noVNC, 127.0.0.1) is taken`,
    );
    server.close();
    await once(server, 'close');
    await expect(assertPortFree('noVNC', '127.0.0.1', port)).resolves.toBeUndefined();
  });
});
