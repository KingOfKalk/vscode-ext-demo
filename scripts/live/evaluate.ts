// Evaluates an expression in a process with an inspector, without pausing it.
import { ActionError } from './errors.ts';
import { InspectorError, NoAnswerError, type Inspector } from './inspector.ts';
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
  /** For the JavaScript, which blocks the process. */
  timeoutMs: number;
  /** For the result, if it is a promise. */
  answerMs: number;
  /** The file that the expression requires modules from; with it there is also `vscode`. */
  requireFrom?: string;
}

/** An async function around it: so `await` works, and `{ a: 1 }` is an object and no block. */
function wrap(expression: string, requireFrom: string | undefined): string {
  const from = JSON.stringify(requireFrom ?? '/');
  const vscode = requireFrom === undefined ? '' : `const vscode = require('vscode');`;
  return `(async () => { const require = process.getBuiltinModule('node:module').createRequire(${from}); ${vscode} return (
${expression}
); })()`;
}

/** Never pauses, also not at `debugger`. Waits for the result if it is a promise. */
export async function evaluateExpression(
  inspector: Inspector,
  expression: string,
  { timeoutMs, answerMs, requireFrom }: EvaluateOptions,
): Promise<Evaluation> {
  const { result, exceptionDetails } = await inspector
    .send(
      'Runtime.evaluate',
      {
        expression: wrap(expression, requireFrom),
        awaitPromise: true,
        disableBreaks: true,
        silent: true,
        timeout: timeoutMs,
      },
      answerMs,
    )
    .catch((error: unknown) => {
      if (wasEnded(error)) {
        throw new ActionError(
          `the expression ran longer than ${timeoutMs / 1000} s and was ended in the extension host`,
        );
      }
      if (error instanceof NoAnswerError) {
        throw new ActionError(
          `no result within ${answerMs / 1000} s: a promise that does not settle, or the extension host is busy or paused`,
        );
      }
      throw error;
    });
  return {
    ok: exceptionDetails === undefined,
    text: await formatRemote(inspector, exceptionDetails?.exception ?? result, {
      depth: 3,
      width: 100,
    }),
  };
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
  try {
    const { result, exceptionDetails } = await inspector.send('Debugger.evaluateOnCallFrame', {
      callFrameId,
      // In parentheses `{ a }` is an object. The line break ends a comment.
      expression: `(${expression}\n)`,
      silent: true,
      timeout: timeoutMs,
    });
    const options = { depth: 2, width: 100 };
    return {
      outcome: exceptionDetails ? 'threw' : 'value',
      text: await formatRemote(inspector, exceptionDetails?.exception ?? result, options),
    };
  } catch (error) {
    if (!wasEnded(error)) throw error;
    return { outcome: 'ended', text: 'ended, it took too long' };
  }
}
