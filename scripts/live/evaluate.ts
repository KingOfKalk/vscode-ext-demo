// Evaluates an expression in a process with an inspector, without pausing it.
import { ActionError, userError } from './errors.ts';
import { InspectorError, NoAnswerError, type Inspector } from './inspector.ts';
import { turnEventLoop, unlessAborted } from './pause.ts';
import { formatRemote } from './values.ts';

/** Whether the inspector says that a timeout ended the JavaScript; "internal error" is how it says so. */
function wasEnded(error: unknown): boolean {
  return (
    error instanceof InspectorError &&
    (error.code === -32603 || error.message === 'Execution was terminated')
  );
}

export interface Evaluation {
  /** false: the expression threw, and the text is what it threw. */
  ok: boolean;
  text: string;
}

export interface EvaluateOptions {
  /** For the JavaScript without a break, which blocks the process. */
  timeoutMs: number;
  /** For the result, if it is a promise: the process works on meanwhile. */
  answerMs: number;
  /** The file that the expression requires modules from; with it there is also `vscode`. */
  requireFrom?: string;
  signal?: AbortSignal;
  /** How long a process that does not turn its event loop after an interrupt may take. */
  interruptMs?: number;
  /** How long the process may take to say in which state it is. */
  stateMs?: number;
}

/**
 * An async function around it: so `await` works, and `{ a: 1 }` is an object and no block. A rejection
 * counts as handled, because the inspector asks for the result only after the process went on.
 */
function wrap(expression: string, requireFrom: string | undefined): string {
  const from = JSON.stringify(requireFrom ?? '/');
  const vscode = requireFrom === undefined ? '' : `const vscode = require('vscode');`;
  return `(() => { const result = (async () => { const require = process.getBuiltinModule('node:module').createRequire(${from}); ${vscode} return (
${expression}
); })(); result.catch(() => undefined); return result; })()`;
}

// The timeout of the inspector is only for the JavaScript before the first `await`. What runs after it
// can block the process for good, so it is ended when the result does not come.

const INTERRUPT_MS = 1000;
const STATE_MS = 1000;
/** For the last look before something is ended. */
const RECOVERED_MS = 100;

async function eventLoopTurns(inspector: Inspector, timeoutMs: number): Promise<boolean> {
  try {
    await turnEventLoop(inspector, timeoutMs);
    return true;
  } catch (error) {
    if (error instanceof NoAnswerError) return false;
    throw error;
  }
}

/** Whether a debugger holds the process; undefined if it does not say. Never pauses it. */
async function isPaused(inspector: Inspector, stateMs: number): Promise<boolean | undefined> {
  let paused = false;
  const stop = inspector.on('Debugger.paused', () => {
    paused = true;
  });
  try {
    // At once, so that nothing runs between them.
    await Promise.all([
      inspector.send('Debugger.enable', undefined, stateMs),
      inspector.send('Debugger.setSkipAllPauses', { skip: true }, stateMs),
      inspector.send('Debugger.disable', undefined, stateMs),
    ]);
    return paused;
  } catch (error) {
    if (error instanceof NoAnswerError) return undefined;
    throw error;
  } finally {
    stop();
  }
}

type Ending = 'idle' | 'paused' | 'ended' | 'blocked' | 'gone';

/**
 * Ends the JavaScript that blocks the process, if some does: the inspector would end what runs next,
 * and that may be anything. Not if a debugger holds it, and not if it does not answer at all: it is in
 * native code, or stopped, and what it runs afterwards is not known.
 */
async function endIfBusy(
  inspector: Inspector,
  timeoutMs: number,
  stateMs: number,
): Promise<Ending> {
  try {
    if (await eventLoopTurns(inspector, timeoutMs)) return 'idle';
    const paused = await isPaused(inspector, stateMs);
    if (paused === undefined) return 'blocked';
    if (paused) return 'paused';
    if (await eventLoopTurns(inspector, Math.min(RECOVERED_MS, timeoutMs))) return 'idle';
    await inspector.send('Runtime.terminateExecution', undefined, stateMs).catch(() => undefined);
    return (await eventLoopTurns(inspector, stateMs)) ? 'ended' : 'blocked';
  } catch {
    // The connection is closed. What runs in a callback of its own, like a loop in a timer, takes the
    // whole process with it when it is ended.
    return 'gone';
  }
}

/** What to say after the reason of the failure. */
const ENDINGS: Record<Exclude<Ending, 'idle'>, string> = {
  paused: '. The extension host is paused by another debugger: continue there first.',
  ended: '. What blocked the extension host was ended.',
  blocked:
    '. The extension host is blocked by native code, or does not run, and goes on when that is over. If the window stays frozen: npm run live -- stop, then start --keep',
  gone: '. What blocked the extension host was ended, and the extension host with it. VS Code starts it again; run: npm run live -- reload',
};

/**
 * Never pauses, also not at `debugger`. Waits for the result if it is a promise. What blocks the
 * process when the result does not come in time, or after an interrupt, is ended; only native code is not.
 * A process that is busy already gets nothing to evaluate, so what is ended began after that.
 */
export async function evaluateExpression(
  inspector: Inspector,
  expression: string,
  options: EvaluateOptions,
): Promise<Evaluation> {
  const { timeoutMs, answerMs, requireFrom, signal } = options;
  const { interruptMs = INTERRUPT_MS, stateMs = STATE_MS } = options;
  const unlessInterrupted = <T>(promise: Promise<T>): Promise<T> =>
    signal ? unlessAborted(signal, promise) : promise;

  const evaluate = async (): Promise<Evaluation> => {
    const end = Date.now() + answerMs;
    let answer = await inspector.send(
      'Runtime.evaluate',
      {
        expression: wrap(expression, requireFrom),
        disableBreaks: true,
        silent: true,
        timeout: timeoutMs,
      },
      answerMs,
    );
    const promiseObjectId = answer.result.objectId;
    if (!answer.exceptionDetails && promiseObjectId !== undefined) {
      // Not `awaitPromise` of the first command: V8 may lose that promise while its reactions still
      // wait, but not one that it handed out.
      const left = Math.max(1, end - Date.now());
      answer = await inspector.send('Runtime.awaitPromise', { promiseObjectId }, left);
    }
    const { result, exceptionDetails } = answer;
    return {
      ok: exceptionDetails === undefined,
      text: await formatRemote(inspector, exceptionDetails?.exception ?? result, {
        depth: 3,
        width: 100,
      }),
    };
  };

  signal?.throwIfAborted();
  if (!(await unlessInterrupted(eventLoopTurns(inspector, timeoutMs)))) {
    throw new ActionError('the extension host is busy or paused; nothing was evaluated');
  }
  try {
    return await unlessInterrupted(evaluate());
  } catch (error) {
    if (wasEnded(error)) {
      throw new ActionError(
        `the expression ran longer than ${timeoutMs / 1000} s and was ended in the extension host`,
      );
    }
    const late = error instanceof NoAnswerError;
    if (!late && !signal?.aborted) throw error;
    const ending = await endIfBusy(inspector, late ? timeoutMs : interruptMs, stateMs);
    const text = late ? `no result within ${answerMs / 1000} s` : userError(error).message;
    const idle = late ? '. The promise did not settle.' : '';
    throw new ActionError(`${text}${ending === 'idle' ? idle : ENDINGS[ending]}`);
  }
}

export interface FrameEvaluation {
  /** `ended`: it took too long. */
  outcome: 'value' | 'threw' | 'ended';
  text: string;
}

/**
 * Evaluates in a frame of a pause, where everything waits for it. A loop that the expression leaves
 * behind (in a promise or a timer) blocks the process after the pause, and nothing ends it.
 */
export async function evaluateInFrame(
  inspector: Inspector,
  callFrameId: string,
  expression: string,
  timeoutMs: number,
): Promise<FrameEvaluation> {
  const answer = await inspector
    .send('Debugger.evaluateOnCallFrame', {
      callFrameId,
      // In parentheses `{ a }` is an object. The line break ends a comment.
      expression: `(${expression}\n)`,
      silent: true,
      timeout: timeoutMs,
    })
    .catch((error: unknown) => {
      if (!wasEnded(error)) throw error;
    });
  if (!answer) return { outcome: 'ended', text: 'ended, it took too long' };
  const { result, exceptionDetails } = answer;
  const options = { depth: 2, width: 100 };
  return {
    outcome: exceptionDetails ? 'threw' : 'value',
    text: await formatRemote(inspector, exceptionDetails?.exception ?? result, options),
  };
}
