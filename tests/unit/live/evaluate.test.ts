// `eval` against a real Node inspector: a child process takes the place of the extension host.
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { ActionError } from '../../../scripts/live/errors.ts';
import { evaluateExpression, type EvaluateOptions } from '../../../scripts/live/evaluate.ts';
import { childScript, connect, increment, spyOnSend } from './inspectedChild.ts';

const script = childScript();
const startChild = () => script.start();

const OPTIONS: EvaluateOptions = { timeoutMs: 300, answerMs: 400, stateMs: 100, interruptMs: 100 };
const TERMINATE = 'Runtime.terminateExecution';

/** Evaluates, and checks that the process goes on as if nothing had been. */
async function evaluate(expression: string, options = OPTIONS) {
  const { child, url } = await startChild();
  const inspector = await connect(url);
  const methods = spyOnSend(inspector);
  const outcome = await evaluateExpression(inspector, expression, options).catch(
    (error: unknown) => {
      if (error instanceof ActionError) return error.message;
      throw error;
    },
  );
  expect(await increment(child)).toBe(2);
  return { outcome, ended: methods.includes(TERMINATE) };
}

describe('evaluateExpression', () => {
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
    expect(await evaluate(expression)).toEqual({ outcome: { ok: true, text }, ended: false });
  });

  it.each([
    ['nope.x', /^ReferenceError: nope is not defined\n\s+at /],
    ['Promise.reject(new TypeError("no"))', /^TypeError: no\n\s+at /],
    ['(() => { throw 5; })()', /^5$/],
    ['a b', /^SyntaxError: /],
    ['', /^SyntaxError: /],
  ])('fails for %j', async (expression, text) => {
    expect(await evaluate(expression)).toEqual({
      outcome: { ok: false, text: expect.stringMatching(text) as string },
      ended: false,
    });
  });

  it('does not stop at `debugger`, also if a debugger is attached', async () => {
    const { child, url } = await startChild();
    await (await connect(url)).send('Debugger.enable');
    const expression = '(() => { debugger; return 1; })()';
    const result = await evaluateExpression(await connect(url), expression, OPTIONS);
    expect(result).toEqual({ ok: true, text: '1' });
    expect(await increment(child)).toBe(2);
  });

  it('ends a loop without an end', async () => {
    const { outcome } = await evaluate('(() => { for (;;); })()');
    expect(outcome).toContain('longer than 0.3 s and was ended');
  });

  it.each([
    ['after an await', '(await null, (() => { for (;;); })())'],
    ['of awaits', '(await (async () => { for (;;) await null; })())'],
    [
      'after an await, that makes garbage',
      '(await null, (() => { for (;;) globalThis.x = {}; })())',
    ],
  ])('ends a loop without an end %s', async (_, expression) => {
    expect(await evaluate(expression)).toEqual({
      outcome: 'no result within 0.4 s. What blocked the extension host was ended.',
      ended: true,
    });
  });

  it('ends a loop that the expression left behind', async () => {
    const { child, url } = await startChild();
    const expression = '(Promise.resolve().then(() => { for (;;) globalThis.x = {}; }), 1)';
    const evaluating = evaluateExpression(await connect(url), expression, OPTIONS);
    await expect(evaluating).rejects.toThrow(/was ended/);
    expect(await increment(child)).toBe(2);
  });

  it('says that the process ended with a loop in a timer', async () => {
    const { url } = await startChild();
    const expression = 'new Promise(() => setTimeout(() => { for (;;); }, 50))';
    await expect(evaluateExpression(await connect(url), expression, OPTIONS)).rejects.toThrow(
      'What blocked the extension host was ended, and the extension host with it',
    );
  });

  it('says that native code blocks, and ends nothing', async () => {
    const expression = `(await null, require('node:child_process').execSync('sleep 1.5') + '')`;
    const { outcome, ended } = await evaluate(expression, { ...OPTIONS, timeoutMs: 100 });
    expect(outcome).toContain('blocked by native code');
    expect(ended).toBe(false);
  });

  it('waits for a promise that is slow, not busy', async () => {
    const expression = 'new Promise((resolve) => setTimeout(() => resolve(1), 1000))';
    expect(await evaluate(expression, { ...OPTIONS, answerMs: 2000 })).toEqual({
      outcome: { ok: true, text: '1' },
      ended: false,
    });
  });

  it('does not wait forever for a promise, and ends nothing', async () => {
    expect(await evaluate('new Promise(() => undefined)')).toEqual({
      outcome: 'no result within 0.4 s. The promise did not settle.',
      ended: false,
    });
  });

  it('evaluates nothing in a process that is busy, and ends nothing', async () => {
    const { child, url } = await startChild();
    const inspector = await connect(url);
    await inspector.send('Runtime.evaluate', {
      expression:
        'setTimeout(() => { const end = Date.now() + 800; while (Date.now() < end) globalThis.x = {}; }, 0)',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const methods = spyOnSend(inspector);
    await expect(evaluateExpression(inspector, 'globalThis.ran = 1', OPTIONS)).rejects.toThrow(
      'the extension host is busy or paused; nothing was evaluated',
    );
    expect(methods).not.toContain(TERMINATE);
    expect(await increment(child)).toBe(2);
    expect(await evaluateExpression(inspector, 'typeof ran', OPTIONS)).toMatchObject({
      text: "'undefined'",
    });
  });

  it('evaluates nothing in a process that another debugger paused', async () => {
    const { child, url } = await startChild();
    const other = await connect(url);
    await other.send('Debugger.enable');
    const paused = other.next('Debugger.paused', AbortSignal.timeout(3000));
    await other.send('Debugger.pause');
    const answer = once(child, 'message');
    child.send('increment');
    await paused;
    await expect(evaluateExpression(await connect(url), '1', OPTIONS)).rejects.toThrow(
      'nothing was evaluated',
    );
    await other.send('Debugger.resume');
    expect((await answer)[0]).toBe(2);
    expect(await increment(child)).toBe(4);
  });

  it('ends nothing in a process that another debugger pauses meanwhile', async () => {
    const { child, url } = await startChild();
    const other = await connect(url);
    await other.send('Debugger.enable');
    const inspector = await connect(url);
    const methods = spyOnSend(inspector);
    const answer = once(child, 'message');
    setTimeout(() => {
      void other.send('Debugger.pause');
      child.send('increment');
    }, 200);
    await expect(
      evaluateExpression(inspector, 'new Promise(() => undefined)', OPTIONS),
    ).rejects.toThrow('paused by another debugger');
    expect(methods).not.toContain(TERMINATE);
    await other.send('Debugger.resume');
    expect((await answer)[0]).toBe(2);
    expect(await increment(child)).toBe(4);
  });

  it('ends nothing in a process that does not run at all', async () => {
    const { child, url } = await startChild();
    const inspector = await connect(url);
    const methods = spyOnSend(inspector);
    setTimeout(() => child.kill('SIGSTOP'), 200);
    await expect(
      evaluateExpression(inspector, 'new Promise(() => undefined)', OPTIONS),
    ).rejects.toThrow('blocked');
    expect(methods).not.toContain(TERMINATE);
    child.kill('SIGCONT');
    expect(await increment(child)).toBe(2);
  });

  it('ends nothing in a process that is not busy any more', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evaluate-'));
    onTestFinished(() => {
      rmSync(dir, { recursive: true });
    });
    const flag = join(dir, 'flag');
    const { child, url } = await startChild();
    const inspector = await connect(url);
    // The loop ends at the moment in which it is asked whether the process is paused.
    const methods = spyOnSend(inspector, (method) => {
      if (method === 'Debugger.enable') writeFileSync(flag, '');
    });
    const expression = `new Promise(() => setTimeout(() => { while (!require('node:fs').existsSync(${JSON.stringify(flag)})); }, 50))`;
    await expect(evaluateExpression(inspector, expression, OPTIONS)).rejects.toThrow(
      'did not settle',
    );
    expect(existsSync(flag)).toBe(true);
    expect(methods).not.toContain(TERMINATE);
    expect(await increment(child)).toBe(2);
  });

  it.each([
    ['ends a loop after an await', '(await null, (() => { for (;;); })())', true],
    ['ends nothing in an idle process', 'new Promise(() => undefined)', false],
  ])('%s when it is interrupted', async (_, expression, ended) => {
    const abort = new AbortController();
    setTimeout(() => {
      abort.abort(new ActionError('interrupted by SIGINT'));
    }, 700);
    const slow = { ...OPTIONS, timeoutMs: 60_000, answerMs: 60_000, signal: abort.signal };
    const result = await evaluate(expression, slow);
    expect(result.outcome).toMatch(/^interrupted by SIGINT/);
    expect(result.ended).toBe(ended);
  });
});
