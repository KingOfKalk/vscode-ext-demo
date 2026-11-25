// A child process with a Node inspector, in the place of the extension host.
import { build } from 'esbuild';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, onTestFinished } from 'vitest';
import { Inspector } from '../../../scripts/live/inspector.ts';

const SOURCE = `class Counter {
  value = 0;
  async increment(step: number): Promise<number> {
    const next = this.value + step;
    this.value = next;
    await Promise.resolve();
    return this.value;
  }
}

const counter = new Counter();

process.on('message', (text: string) => {
  if (text === 'debugger') {
    debugger;
  }
  if (text === 'exit') process.exit(0);
  void counter.increment(2).then((count) => process.send?.(count));
});
process.send?.('ready');
`;

export interface ChildScript {
  /** The URL of the bundle, as the inspector names it. */
  url(): string;
  map(): object;
  start(): Promise<{ child: ChildProcess; url: string }>;
}

/** Builds the script once for the tests of a file. */
export function childScript(): ChildScript {
  const root = mkdtempSync(join(tmpdir(), 'inspected-'));
  const bundle = join(root, 'dist', 'child.cjs');
  let map: object = {};

  beforeAll(async () => {
    writeFileSync(join(root, 'child.ts'), SOURCE);
    await build({
      absWorkingDir: root,
      entryPoints: ['child.ts'],
      outfile: bundle,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      bundle: true,
      sourcemap: 'linked',
    });
    map = JSON.parse(readFileSync(`${bundle}.map`, 'utf8')) as object;
  });

  afterAll(() => {
    rmSync(root, { recursive: true });
  });

  return { url: () => pathToFileURL(bundle).href, map: () => map, start: () => startChild(bundle) };
}

async function startChild(bundle: string): Promise<{ child: ChildProcess; url: string }> {
  const child = fork(bundle, [], {
    execArgv: ['--inspect=127.0.0.1:0'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  onTestFinished(() => void child.kill('SIGKILL'));
  const ready = once(child, 'message');
  if (!child.stderr) throw new Error('no stderr');
  for await (const line of createInterface(child.stderr)) {
    const url = /^Debugger listening on (ws:\S+)/.exec(line)?.[1];
    if (url !== undefined) {
      await ready;
      return { child, url };
    }
  }
  throw new Error('the child has no inspector');
}

export async function connect(url: string): Promise<Inspector> {
  const inspector = await Inspector.connect(url);
  onTestFinished(() => {
    inspector.close();
  });
  return inspector;
}

/** What the child counts to. It answers only if it is not paused. */
export async function increment(child: ChildProcess): Promise<unknown> {
  const answer = once(child, 'message', { signal: AbortSignal.timeout(3000) });
  child.send('increment');
  return ((await answer) as unknown[])[0];
}

/** The methods that are sent from now on; `onSend` runs right after each is sent. */
export function spyOnSend(inspector: Inspector, onSend?: (method: string) => void): string[] {
  const methods: string[] = [];
  const send = inspector.send.bind(inspector) as (...args: unknown[]) => Promise<unknown>;
  Object.assign(inspector, {
    send: (method: string, ...rest: unknown[]) => {
      const answer = send(method, ...rest);
      methods.push(method);
      onSend?.(method);
      return answer;
    },
  });
  return methods;
}
