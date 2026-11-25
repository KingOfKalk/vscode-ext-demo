// The debugger against a real Node inspector: a child process takes the place of the extension host.
import { build } from 'esbuild';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { ActionError } from '../../../scripts/live/errors.ts';
import { evaluateExpression, evaluateInFrame } from '../../../scripts/live/evaluate.ts';
import { Inspector } from '../../../scripts/live/inspector.ts';
import { assertContinues, pauseAt, type PauseRequest } from '../../../scripts/live/pause.ts';
import { toGenerated, toSource } from '../../../scripts/live/sourceMap.ts';

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

const root = mkdtempSync(join(tmpdir(), 'pause-'));
const bundle = join(root, 'dist', 'child.cjs');
let map: object;

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

async function startChild(): Promise<{ child: ChildProcess; url: string }> {
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

async function connect(url: string): Promise<Inspector> {
  const inspector = await Inspector.connect(url);
  onTestFinished(() => {
    inspector.close();
  });
  return inspector;
}

/** What the child counts to. It answers only if it is not paused. */
async function increment(child: ChildProcess): Promise<unknown> {
  const answer = once(child, 'message', { signal: AbortSignal.timeout(3000) });
  child.send('increment');
  return ((await answer) as unknown[])[0];
}

function request(line: number, more: Partial<PauseRequest> = {}): PauseRequest {
  return {
    what: `child.ts:${line}`,
    url: pathToFileURL(bundle).href,
    position: toGenerated(map, 'child.ts', line),
    hitTimeoutMs: 5000,
    lookTimeoutMs: 5000,
    triggerTimeoutMs: 5000,
    signal: new AbortController().signal,
    ...more,
  };
}

function triggerBy(child: ChildProcess, text = 'increment'): () => Promise<string> {
  return () => {
    child.send(text);
    return Promise.resolve(`sent ${text}`);
  };
}

const never = () => new Promise<never>(() => undefined);

describe('pauseAt', () => {
  it('pauses once, resumes, and leaves no breakpoint', async () => {
    const { child, url } = await startChild();
    const inspector = await connect(url);
    const answer = once(child, 'message');
    const { seen, trigger } = await pauseAt(
      inspector,
      request(5, { trigger: triggerBy(child) }),
      async (pause) => {
        const [top] = pause.callFrames;
        if (!top) throw new Error('no frame');
        const { result } = await inspector.send('Debugger.evaluateOnCallFrame', {
          callFrameId: top.callFrameId,
          expression: '[this.value, next].join()',
        });
        const { lineNumber, columnNumber = 0 } = top.location;
        return { value: result.value as unknown, at: toSource(map, lineNumber, columnNumber) };
      },
    );
    expect(seen).toMatchObject({ value: '0,2', at: { file: 'child.ts', line: 5 } });
    await expect(trigger).resolves.toBe('sent increment');
    await assertContinues(inspector);
    expect((await answer)[0]).toBe(2);
    expect(await increment(child)).toBe(4);
  });

  it('says where V8 put the breakpoint', async () => {
    const { child, url } = await startChild();
    let line: number | undefined;
    await pauseAt(
      await connect(url),
      request(3, {
        trigger: triggerBy(child),
        onSet: ({ lineNumber, columnNumber }) => {
          line = toSource(map, lineNumber, columnNumber ?? 0)?.line;
        },
      }),
      () => Promise.resolve(),
    );
    expect(line).toBe(4);
  });

  it('pauses after an await, with the stack before it', async () => {
    const { child, url } = await startChild();
    const { seen } = await pauseAt(
      await connect(url),
      request(7, { trigger: triggerBy(child) }),
      (pause) => Promise.resolve(pause),
    );
    expect(seen.callFrames[0]?.functionName).toBe('increment');
    expect(seen.asyncStackTrace?.callFrames.length).toBeGreaterThan(0);
    expect(await increment(child)).toBe(2);
  });

  it('fails without a hit, and leaves no breakpoint', async () => {
    const { child, url } = await startChild();
    const waiting = pauseAt(await connect(url), request(5, { hitTimeoutMs: 200 }), never);
    await expect(waiting).rejects.toThrow('child.ts:5: no hit within 0.2 s');
    expect(await increment(child)).toBe(2);
  });

  it('says in the failure what the trigger did', async () => {
    const { url } = await startChild();
    const inspector = await connect(url);
    const trigger = () => Promise.resolve('clicked nothing');
    await expect(
      pauseAt(inspector, request(5, { hitTimeoutMs: 200, trigger }), never),
    ).rejects.toThrow('clicked nothing');
    await expect(
      pauseAt(await connect(url), request(5, { hitTimeoutMs: 200, trigger: never }), never),
    ).rejects.toThrow('is still at work');
  });

  it('fails at once when the trigger fails', async () => {
    const { child, url } = await startChild();
    const trigger = () => Promise.reject(new ActionError('an editor lies over the window'));
    await expect(pauseAt(await connect(url), request(5, { trigger }), never)).rejects.toThrow(
      '--do failed: an editor lies over the window',
    );
    expect(await increment(child)).toBe(2);
  });

  it('fails when the trigger takes too long', async () => {
    const { url } = await startChild();
    const trigger = never;
    await expect(
      pauseAt(await connect(url), request(5, { trigger, triggerTimeoutMs: 100 }), never),
    ).rejects.toThrow('--do failed: it did not end within 0.1 s');
  });

  it('continues when interrupted during the pause', async () => {
    const { child, url } = await startChild();
    const abort = new AbortController();
    const look = () => {
      abort.abort(new Error('interrupted by SIGINT'));
      return never();
    };
    const waiting = pauseAt(
      await connect(url),
      request(5, { trigger: triggerBy(child), signal: abort.signal }),
      look,
    );
    const answer = once(child, 'message');
    await expect(waiting).rejects.toThrow('interrupted by SIGINT');
    expect((await answer)[0]).toBe(2);
    expect(await increment(child)).toBe(4);
  });

  it('continues when looking at the pause fails', async () => {
    const { child, url } = await startChild();
    const answer = once(child, 'message');
    await expect(
      pauseAt(await connect(url), request(5, { trigger: triggerBy(child) }), () =>
        Promise.reject(new Error('cannot look')),
      ),
    ).rejects.toThrow('cannot look');
    expect((await answer)[0]).toBe(2);
    expect(await increment(child)).toBe(4);
  });

  it('continues when the connection breaks during the pause', async () => {
    const { child, url } = await startChild();
    const inspector = await connect(url);
    const answer = once(child, 'message');
    await expect(
      pauseAt(inspector, request(5, { trigger: triggerBy(child) }), () => {
        inspector.close();
        return never();
      }),
    ).rejects.toThrow('closed the connection');
    expect((await answer)[0]).toBe(2);
    expect(await increment(child)).toBe(4);
  });

  it('refuses a host that another debugger paused, and leaves it paused', async () => {
    const { child, url } = await startChild();
    const other = await connect(url);
    await other.send('Debugger.enable');
    const paused = other.next('Debugger.paused', AbortSignal.timeout(3000));
    await other.send('Debugger.pause');
    child.send('increment');
    await paused;
    const answer = once(child, 'message');
    await expect(pauseAt(await connect(url), request(5), never)).rejects.toThrow('already paused');
    // Not resumed: `Debugger.resume` fails if nothing is paused.
    await other.send('Debugger.resume');
    expect((await answer)[0]).toBe(2);
  });

  it('says that another debugger continued in the pause', async () => {
    const { child, url } = await startChild();
    const other = await connect(url);
    await other.send('Debugger.enable');
    const inspector = await connect(url);
    const answer = once(child, 'message');
    await expect(
      pauseAt(inspector, request(5, { trigger: triggerBy(child) }), async (pause) => {
        await other.send('Debugger.resume');
        return inspector.send('Debugger.evaluateOnCallFrame', {
          callFrameId: pause.callFrames[0]?.callFrameId ?? '',
          expression: '1',
        });
      }),
    ).rejects.toThrow('another debugger continued');
    expect((await answer)[0]).toBe(2);
    expect(await increment(child)).toBe(4);
  });

  it('refuses a pause that is not at the breakpoint', async () => {
    const { child, url } = await startChild();
    const answer = once(child, 'message');
    await expect(
      pauseAt(await connect(url), request(5, { trigger: triggerBy(child, 'debugger') }), never),
    ).rejects.toThrow('not at the breakpoint at child.ts:5');
    expect((await answer)[0]).toBe(2);
  });

  it('continues after such a pause also if another debugger is attached', async () => {
    const { child, url } = await startChild();
    // V8 only continues by itself if no debugger is left; VS Code leaves one after a long pause.
    await (await connect(url)).send('Debugger.enable');
    const answer = once(child, 'message');
    await expect(
      pauseAt(await connect(url), request(5, { trigger: triggerBy(child, 'debugger') }), never),
    ).rejects.toThrow('not at the breakpoint');
    expect((await answer)[0]).toBe(2);
  });

  it('continues when looking takes too long', async () => {
    const { child, url } = await startChild();
    const answer = once(child, 'message');
    await expect(
      pauseAt(
        await connect(url),
        request(5, { trigger: triggerBy(child), lookTimeoutMs: 100 }),
        never,
      ),
    ).rejects.toThrow('longer than 0.1 s');
    expect((await answer)[0]).toBe(2);
    expect(await increment(child)).toBe(4);
  });

  it('fails when the process ends', async () => {
    const { child, url } = await startChild();
    await expect(
      pauseAt(await connect(url), request(5, { trigger: triggerBy(child, 'exit') }), never),
    ).rejects.toThrow('closed the connection');
  });

  it('fails for a script that is not loaded', async () => {
    const { url } = await startChild();
    await expect(
      pauseAt(await connect(url), request(5, { url: 'file:///nope.js' }), never),
    ).rejects.toThrow('no place to stop at child.ts:5');
  });
});

describe('evaluateInFrame', () => {
  it('ends a loop without an end, and the function goes on', async () => {
    const { child, url } = await startChild();
    const inspector = await connect(url);
    const answer = once(child, 'message');
    const { seen } = await pauseAt(
      inspector,
      request(5, { trigger: triggerBy(child) }),
      async ({ callFrames }) => {
        const id = callFrames[0]?.callFrameId ?? '';
        return {
          value: await evaluateInFrame(inspector, id, '{ next, list: [next] }', 1000),
          threw: await evaluateInFrame(inspector, id, 'next.a.b', 1000),
          ended: await evaluateInFrame(inspector, id, '(() => { for (;;); })()', 100),
          after: await evaluateInFrame(inspector, id, 'this.value + next', 1000),
        };
      },
    );
    expect(seen).toMatchObject({
      value: { outcome: 'value', text: '{ next: 2, list: [ 2 ] }' },
      threw: { outcome: 'threw', text: expect.stringMatching(/^TypeError: /) as string },
      ended: { outcome: 'ended' },
      after: { outcome: 'value', text: '2' },
    });
    expect((await answer)[0]).toBe(2);
    expect(await increment(child)).toBe(4);
  });
});

describe('evaluateExpression', () => {
  const evaluate = async (expression: string) => {
    const { child, url } = await startChild();
    const result = await evaluateExpression(await connect(url), expression, {
      timeoutMs: 500,
      answerMs: 1000,
    });
    return { ...result, next: await increment(child) };
  };

  it.each([
    ['1+1', '2'],
    ["'a' + 'b'", "'ab'"],
    ['undefined', 'undefined'],
    ['{ a: [1, { b: 2 }] }', '{ a: [ 1, { b: 2 } ] }'],
    ['Promise.resolve([1])', '[ 1 ]'],
    ['(await Promise.resolve(3)) + 1 // four', '4'],
    ["require('node:path').sep", "'/'"],
    ['Symbol("a")', 'Symbol(a)'],
  ])('%s', async (expression, text) => {
    expect(await evaluate(expression)).toEqual({ ok: true, text, next: 2 });
  });

  it.each([
    ['nope.x', /^ReferenceError: nope is not defined\n\s+at /],
    ['Promise.reject(new TypeError("no"))', /^TypeError: no\n\s+at /],
    ['(() => { throw 5; })()', /^5$/],
    ['a b', /^SyntaxError: /],
    ['', /^SyntaxError: /],
  ])('fails for %j', async (expression, text) => {
    const result = await evaluate(expression);
    expect(result).toMatchObject({ ok: false, next: 2 });
    expect(result.text).toMatch(text);
  });

  it('ends a loop without an end', async () => {
    await expect(evaluate('(() => { for (;;); })()')).rejects.toThrow('longer than 0.5 s');
  });

  it('does not wait forever for a promise', async () => {
    await expect(evaluate('new Promise(() => undefined)')).rejects.toThrow('no result within 1 s');
  });

  it('does not stop at `debugger`, also if a debugger is attached', async () => {
    const { child, url } = await startChild();
    await (await connect(url)).send('Debugger.enable');
    const expression = '(() => { debugger; return 1; })()';
    const options = { timeoutMs: 500, answerMs: 1000 };
    const result = await evaluateExpression(await connect(url), expression, options);
    expect(result).toEqual({ ok: true, text: '1' });
    expect(await increment(child)).toBe(2);
  });
});
