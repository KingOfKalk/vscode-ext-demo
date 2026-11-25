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
}

/** An async function around it: so `await` works, and `{ a: 1 }` is an object and no block. */
function wrap(expression: string, requireFrom: string | undefined): string {
  const from = JSON.stringify(requireFrom ?? '/');
  const vscode = requireFrom === undefined ? '' : `const vscode = require('vscode');`;
  return `(async () => { const require = process.getBuiltinModule('node:module').createRequire(${from}); ${vscode} return (
${expression}
); })()`;
}

// The timeout of the inspector is only for the JavaScript before the first `await`. What runs after it
// can block the process for good, so it is ended when the result does not come.

/** Whoever does not turn the event loop for so long after an interrupt is busy. */
const INTERRUPT_MS = 1000;
const STATE_MS = 1000;

async function eventLoopTurns(inspector: Inspector, timeoutMs: number): Promise<boolean> {
  try {
    await turnEventLoop(inspector, timeoutMs);
    return true;
  } catch (error) {
    if (error instanceof NoAnswerError) return false;
    throw error;
  }
}

/** Whether a debugger holds the process. Never pauses it. */
async function isPaused(inspector: Inspector): Promise<boolean> {
  let paused = false;
  const stop = inspector.on('Debugger.paused', () => {
    paused = true;
  });
  // At once, so that nothing runs between them.
  await Promise.all([
    inspector.send('Debugger.enable', undefined, STATE_MS),
    inspector.send('Debugger.setSkipAllPauses', { skip: true }, STATE_MS),
    inspector.send('Debugger.disable', undefined, STATE_MS),
  ]).catch(() => undefined); // Blocked in native code.
  stop();
  return paused;
}

/**
 * Ends the JavaScript that blocks the process. Only if some does: the inspector would end what runs
 * next, and that may be anything. Not if it is paused: that is for the debugger that did it.
 */
type Ending = 'idle' | 'paused' | 'ended' | 'blocked' | 'gone';

async function endIfBusy(inspector: Inspector, timeoutMs: number): Promise<Ending> {
  try {
    if (await eventLoopTurns(inspector, timeoutMs)) return 'idle';
    if (await isPaused(inspector)) return 'paused';
    await inspector.send('Runtime.terminateExecution', undefined, STATE_MS).catch(() => undefined);
    return (await eventLoopTurns(inspector, STATE_MS)) ? 'ended' : 'blocked';
  } catch {
    // The connection is closed. What runs in a callback of its own, like a timer, takes the process
    // with it when it is ended.
    return 'gone';
  }
}

/** What to say after the reason of the failure. */
const ENDINGS: Record<Exclude<Ending, 'idle'>, string> = {
  paused: '. The extension host is paused by another debugger: continue there first.',
  ended: '. The expression blocked the extension host and was ended.',
  blocked:
    '. The extension host is blocked by native code and goes on when that returns. If the window stays frozen: npm run live -- stop, then start --keep',
  gone: '. The expression blocked the extension host and was ended, and the extension host with it. VS Code starts it again; run: npm run live -- reload',
};

/**
 * Never pauses, also not at `debugger`. Waits for the result if it is a promise. What blocks the
 * process when the result does not come in time, or after an interrupt, is ended; only native code is not.
 */
export async function evaluateExpression(
  inspector: Inspector,
  expression: string,
  { timeoutMs, answerMs, requireFrom, signal }: EvaluateOptions,
): Promise<Evaluation> {
  const evaluate = async (): Promise<Evaluation> => {
    const { result, exceptionDetails } = await inspector.send(
      'Runtime.evaluate',
      {
        expression: wrap(expression, requireFrom),
        awaitPromise: true,
        disableBreaks: true,
        silent: true,
        timeout: timeoutMs,
      },
      answerMs,
    );
    return {
      ok: exceptionDetails === undefined,
      text: await formatRemote(inspector, exceptionDetails?.exception ?? result, {
        depth: 3,
        width: 100,
      }),
    };
  };

  signal?.throwIfAborted();
  try {
    return await (signal ? unlessAborted(signal, evaluate()) : evaluate());
  } catch (error) {
    if (wasEnded(error)) {
      throw new ActionError(
        `the expression ran longer than ${timeoutMs / 1000} s and was ended in the extension host`,
      );
    }
    if (error instanceof InspectorError && error.message === 'Promise was collected') {
      throw new ActionError('the promise can never settle: nothing refers to it any more');
    }
    const late = error instanceof NoAnswerError;
    if (!late && !signal?.aborted) throw error;
    const ending = await endIfBusy(inspector, late ? timeoutMs : INTERRUPT_MS);
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

/** Evaluates in a frame of a pause, where everything waits for it. */
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
