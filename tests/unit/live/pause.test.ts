// The debugger against a real Node inspector: a child process takes the place of the extension host.
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createConnection, createServer, type AddressInfo, type Socket } from 'node:net';
import { describe, expect, it, onTestFinished } from 'vitest';
import { ActionError } from '../../../scripts/live/errors.ts';
import { evaluateInFrame } from '../../../scripts/live/evaluate.ts';
import { Inspector } from '../../../scripts/live/inspector.ts';
import { pauseAt, type Pause, type PauseRequest } from '../../../scripts/live/pause.ts';
import { toGenerated, toSource } from '../../../scripts/live/sourceMap.ts';
import { childScript, connect, increment, spyOnSend } from './inspectedChild.ts';

const script = childScript();
const startChild = () => script.start();

function request(line: number, more: Partial<PauseRequest> = {}): PauseRequest {
  return {
    what: `child.ts:${line}`,
    url: script.url(),
    position: toGenerated(script.map(), 'child.ts', line),
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

/** Blocks the paused process in native code, which no timeout of the inspector can end. */
async function block(inspector: Inspector, { callFrames }: Pause, ms: number): Promise<void> {
  await inspector.send('Debugger.evaluateOnCallFrame', {
    callFrameId: callFrames[0]?.callFrameId ?? '',
    expression: `process.getBuiltinModule('node:child_process').execSync('sleep ${ms / 1000}')`,
  });
}

/** Blocks the process in native code, from now on. */
async function blockFor(inspector: Inspector, seconds: number): Promise<void> {
  await inspector.send('Runtime.evaluate', {
    expression: `setTimeout(() => process.getBuiltinModule('node:child_process').execSync('sleep ${seconds}'), 0)`,
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
}

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
        return {
          value: result.value as unknown,
          at: toSource(script.map(), lineNumber, columnNumber),
        };
      },
    );
    expect(seen).toMatchObject({ value: '0,2', at: { file: 'child.ts', line: 5 } });
    await expect(trigger).resolves.toBe('sent increment');
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
          line = toSource(script.map(), lineNumber, columnNumber ?? 0)?.line;
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

  it('continues after a block that outlasts the cleanup, also if another debugger is attached', async () => {
    const { child, url } = await startChild();
    await (await connect(url)).send('Debugger.enable');
    const inspector = await connect(url);
    const answer = once(child, 'message');
    const pausing = pauseAt(
      inspector,
      request(5, { trigger: triggerBy(child), lookTimeoutMs: 100, cleanupMs: 200 }),
      (pause) => block(inspector, pause, 1500),
    );
    // It is not known yet that it continues, so it does not say so.
    const error = await pausing.catch((reason: unknown) => reason as Error);
    expect(error).toBeInstanceOf(ActionError);
    expect((error as Error).message).toContain('longer than 0.1 s');
    expect((error as Error).message).toContain('gave no answer within 0.2 s');
    expect((error as Error).message).not.toContain('continues.');
    expect((await answer)[0]).toBe(2);
    expect(await increment(child)).toBe(4);
  });

  it('says that the process continues once that is known', async () => {
    const { child, url } = await startChild();
    const inspector = await connect(url);
    await expect(
      pauseAt(
        inspector,
        request(5, { trigger: triggerBy(child), lookTimeoutMs: 100, cleanupMs: 3000 }),
        (pause) => block(inspector, pause, 500),
      ),
    ).rejects.toThrow('longer than 0.1 s\nThe extension host continues.');
    expect(await increment(child)).toBe(2);
  });

  it('leaves nothing if it is interrupted before the breakpoint has an answer', async () => {
    const { child, url } = await startChild();
    await (await connect(url)).send('Debugger.enable');
    const inspector = await connect(url);
    const abort = new AbortController();
    const methods = spyOnSend(inspector, (method) => {
      if (method !== 'Debugger.setBreakpointByUrl') return;
      child.send('increment');
      queueMicrotask(() => {
        abort.abort(new ActionError('interrupted by SIGINT'));
      });
    });
    const answer = once(child, 'message');
    await expect(pauseAt(inspector, request(5, { signal: abort.signal }), never)).rejects.toThrow(
      'interrupted by SIGINT',
    );
    expect(methods.slice(methods.indexOf('Debugger.setBreakpointByUrl') + 1)).toEqual([
      'Debugger.setBreakpointsActive',
      'Debugger.resume',
      'Debugger.disable',
      'Runtime.evaluate',
      'Runtime.awaitPromise',
    ]);
    expect((await answer)[0]).toBe(2);
    expect(await increment(child)).toBe(4);
  });

  it('does nothing if it is interrupted before', async () => {
    const { child, url } = await startChild();
    const abort = new AbortController();
    abort.abort(new Error('interrupted by SIGINT'));
    let set = false;
    await expect(
      pauseAt(
        await connect(url),
        request(5, { signal: abort.signal, onSet: () => void (set = true) }),
        never,
      ),
    ).rejects.toThrow('interrupted by SIGINT');
    expect(set).toBe(false);
    expect(await increment(child)).toBe(2);
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

describe('Inspector.connect', () => {
  it.each(['before it is open', 'before it is answered'])('is interrupted %s', async (when) => {
    const { url } = await startChild();
    if (when === 'before it is answered') await blockFor(await connect(url), 2);
    const server = createServer().listen(0, '127.0.0.1');
    onTestFinished(() => void server.close());
    await once(server, 'listening');
    // A server that never answers.
    const silent = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const abort = new AbortController();
    const connecting = Inspector.connect(
      when === 'before it is open' ? silent : url,
      5000,
      abort.signal,
    );
    setTimeout(() => {
      abort.abort(new ActionError('interrupted by SIGINT'));
    }, 100);
    const start = Date.now();
    await expect(connecting).rejects.toThrow('interrupted by SIGINT');
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('closes the connection if the process does not answer', async () => {
    const { url } = await startChild();
    const inspector = await connect(url);
    // In between, to see whether the connection stays.
    const { port, hostname } = new URL(url);
    const proxy = createServer((socket) => {
      const through = createConnection(Number(port), hostname);
      socket.pipe(through).pipe(socket);
    }).listen(0, '127.0.0.1');
    onTestFinished(() => void proxy.close());
    await once(proxy, 'listening');
    const client = once(proxy, 'connection') as Promise<[Socket]>;
    const address = new URL(url);
    address.port = String((proxy.address() as AddressInfo).port);

    // Blocked: the thread of the inspector takes the connection, but nothing answers.
    await blockFor(inspector, 2);
    const connecting = Inspector.connect(address.href, 200);
    const [socket] = await client;
    const closed = once(socket, 'close', { signal: AbortSignal.timeout(1000) });
    await expect(connecting).rejects.toThrow('no answer within 0.2 s');
    await closed;
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
