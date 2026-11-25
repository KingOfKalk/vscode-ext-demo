import type { ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanEnv, killGroup, run, startXvfb } from '../../scripts/vscode-run.mjs';

describe('cleanEnv', () => {
  it('sets HOME and drops what would change how VS Code starts', () => {
    expect(
      cleanEnv('/tmp/home', {
        HOME: '/home/someone',
        PATH: '/usr/bin',
        VSCODE_IPC_HOOK_CLI: 'a',
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '--inspect',
        XDG_CONFIG_HOME: '/home/someone/.config',
        WAYLAND_DISPLAY: 'wayland-0',
        MY_VSCODE_X: 'stays',
      }),
    ).toEqual({ HOME: '/tmp/home', PATH: '/usr/bin', MY_VSCODE_X: 'stays' });
  });
});

describe('run', () => {
  it('throws with the exit code', () => {
    expect(() => {
      run('sh', ['-c', 'exit 3']);
    }).toThrow('sh -c exit 3 failed (exit 3)');
  });

  it('throws if the command cannot be started', () => {
    expect(() => {
      run('/no/such/command', []);
    }).toThrow('ENOENT');
  });

  it('ends a command that takes too long', () => {
    expect(() => {
      run('sleep', ['30'], { timeoutMs: 200 });
    }).toThrow('sleep 30 did not finish within 0.2 s');
  });
});

describe('startXvfb', () => {
  let dir: string;
  let children: ChildProcess[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xvfb-'));
    children = [];
  });

  afterEach(() => {
    for (const { pid } of children) killGroup(pid);
    rmSync(dir, { recursive: true });
  });

  /** Starts a shell script in place of Xvfb. */
  function startFake(script: string): Promise<string> {
    const file = join(dir, 'Xvfb');
    writeFileSync(file, `#!/bin/sh\n${script}\n`);
    chmodSync(file, 0o755);
    return startXvfb({
      onSpawn: (child) => children.push(child),
      env: { PATH: `${dir}:${process.env.PATH ?? ''}` },
      timeoutMs: 1000,
    });
  }

  it('returns the display', async () => {
    await expect(startFake('printf 4 >&3; sleep 0.1; echo 2 >&3; exec sleep 30')).resolves.toBe(
      ':42',
    );
  });

  it('fails if Xvfb ends, with its errors', async () => {
    await expect(startFake('echo no display >&2; exit 1')).rejects.toThrow(
      /^Xvfb ended \(exit 1\): /,
    );
  });

  it('fails if Xvfb does not answer in time', async () => {
    await expect(startFake('exec sleep 30')).rejects.toThrow('Xvfb was not ready within 1 s');
  });

  it('names the script that installs Xvfb', async () => {
    await expect(
      startXvfb({ onSpawn: (child) => children.push(child), env: { PATH: dir } }),
    ).rejects.toThrow('run scripts/install-system-deps.sh');
  });
});

describe('killGroup', () => {
  it('ignores a group that is gone', () => {
    expect(() => {
      killGroup(undefined);
      killGroup(2 ** 22 + 1);
    }).not.toThrow();
  });
});
